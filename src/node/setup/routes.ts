import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getGlobalDispatcher } from "undici";
import { z } from "zod";
import { apiError, jsonBody } from "../../http.js";
import { masterKeys } from "../../keyring.js";
import {
  SETUP_CHECKS,
  type SetupCheckStep,
  type SetupHealth,
  type SetupSettingsView,
  type SetupState,
} from "../../shared/index.js";
import type { AppEnv } from "../../types.js";
import { type Check, checkGithub, checkGitlab, checkModels, checkSignIn } from "./checks.js";
import { isSetupCode, openSettings, settingsOpen } from "./code.js";
import { type HealthContext, healthReport } from "./health.js";
import { dispatcherFor } from "./network.js";
import {
  checkSettings,
  gatewayOf,
  isSecret,
  lockedBy,
  SETTING_NAMES,
  type SettingName,
  type Settings,
  varsOf,
} from "./settings.js";
import { loadSettings, saveSettings } from "./store.js";

// /api/setup: the server's settings page, open to whoever has the setup
// code (./code.ts). GET / says, to anyone, whether the server still needs
// setting up; the rest needs the code's cookie.

export type SetupOptions = {
  /** The process's own environment, which wins over a saved setting. */
  env: Record<string, string | undefined>;
  /** Whether nobody can sign in yet. */
  needed: boolean;
  /** When this configuration started: the page waits for a newer one after a restart. */
  startedAt: number;
  /** Why the server would not start with these variables; undefined when it would. */
  startError: (vars: Record<string, string>) => string | undefined;
  /** What the health page reads besides the database. */
  health: Omit<HealthContext, "db" | "now" | "dispatcher">;
  /** Starts the server again with the saved settings. */
  restart: () => void;
};

const settingsBody = z.object({
  values: z.record(z.string(), z.string().max(300_000).nullable()),
});

const checkBody = settingsBody.extend({ step: z.enum(SETUP_CHECKS) });

export function setupRoute(options: SetupOptions) {
  const route = new Hono<AppEnv>();

  route.get("/", (c) =>
    c.json({ needed: options.needed, startedAt: options.startedAt } satisfies SetupState),
  );

  route.post("/unlock", jsonBody(z.object({ code: z.string().max(64) })), async (c) => {
    const { success } = await c.env.DEVICE_LOOKUPS.limit({ key: `setup:${c.var.clientAddress}` });
    if (!success) {
      c.header("retry-after", "60");
      return apiError(c, "slow_down", {}, 429);
    }
    if (!(await isSetupCode(c.env.SESSION_SECRET, c.req.valid("json").code))) {
      return apiError(c, "unauthenticated");
    }
    await openSettings(c, c.env.SESSION_SECRET, new Date());
    return c.json({ ok: true });
  });

  route.use("/*", opened);

  route.get("/settings", async (c) => c.json(await shown(c)));

  route.put("/settings", jsonBody(settingsBody, { max: 512 * 1024 }), async (c) => {
    const { values, issues } = checkSettings(c.req.valid("json").values);
    for (const name of Object.keys(values) as SettingName[]) {
      const env = lockedBy(name, options.env);
      if (env) issues.push({ path: [name], message: `set by ${env} in the server's environment` });
    }
    if (issues.length > 0) return apiError(c, "invalid_body", { issues });
    const saved = await loadSettings(c.var.db, masterKeys(c.env));
    const next: Settings = { ...saved };
    for (const [name, value] of Object.entries(values) as [SettingName, string | null][]) {
      if (value === null) delete next[name];
      else next[name] = value;
    }
    const error = options.startError({ ...varsOf(next), ...defined(options.env) });
    if (error) return apiError(c, "invalid_body", { issues: [{ path: [], message: error }] });
    await saveSettings(c.var.db, c.env.MASTER_KEY, values, new Date());
    return c.json(await shown(c));
  });

  route.post("/check", jsonBody(checkBody, { max: 512 * 1024 }), async (c) => {
    const { step, values } = c.req.valid("json");
    const draft = checkSettings(values);
    if (draft.issues.length > 0) return apiError(c, "invalid_body", { issues: draft.issues });
    const s: Settings = { ...(await loadSettings(c.var.db, masterKeys(c.env))) };
    for (const [name, value] of Object.entries(draft.values) as [SettingName, string | null][]) {
      // A secret left blank keeps the saved one: the page never has it.
      if (value !== null) s[name] = value;
      else if (!isSecret(name)) delete s[name];
    }
    const dispatcher = dispatcherFor({
      ca: s["network.caCertificates"],
      proxy: s["network.httpsProxy"] ?? options.env.HTTPS_PROXY ?? options.env.https_proxy,
      noProxy: s["network.noProxy"] ?? options.env.NO_PROXY ?? options.env.no_proxy,
    });
    try {
      return c.json({ checks: await runCheck(step, s, dispatcher) });
    } finally {
      await dispatcher.close();
    }
  });

  route.post("/apply", (c) => {
    // After the answer has gone: the page then waits for the new start.
    setTimeout(options.restart, 100);
    return c.json({ restarting: true });
  });

  route.get("/health", async (c) =>
    c.json({
      sections: await healthReport({
        ...options.health,
        db: c.var.db,
        now: new Date(),
        dispatcher: getGlobalDispatcher(),
      }),
    } satisfies SetupHealth),
  );

  /** The settings as the page shows them: secrets only as set, and which the environment locks. */
  async function shown(c: Context<AppEnv>): Promise<SetupSettingsView> {
    const saved = await loadSettings(c.var.db, masterKeys(c.env));
    const origin = new URL(c.req.url).origin;
    return {
      fields: Object.fromEntries(
        SETTING_NAMES.map((name) => {
          const value = saved[name];
          const locked = lockedBy(name, options.env);
          return [
            name,
            {
              set: value !== undefined || locked !== undefined,
              ...(value !== undefined && !isSecret(name) ? { value } : {}),
              ...(locked ? { lockedBy: locked } : {}),
            },
          ];
        }),
      ) as SetupSettingsView["fields"],
      // What the providers' applications for ocra are given.
      addresses: {
        signIn: `${origin}/api/auth/oidc/callback`,
        gitlab: `${origin}/api/platforms/gitlab/callback`,
        github: `${origin}/api/auth/github/callback`,
        githubWebhook: `${origin}/api/webhooks/github`,
      },
    };
  }

  return route;
}

/** The rest of /api/setup: a browser that gave the code, on this origin. */
const opened: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await settingsOpen(c, c.env.SESSION_SECRET, new Date()))) {
    return apiError(c, "unauthenticated");
  }
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return apiError(c, "bad_origin");
  }
  await next();
};

function runCheck(
  step: SetupCheckStep,
  s: Settings,
  dispatcher: ReturnType<typeof dispatcherFor>,
): Promise<Check[]> {
  switch (step) {
    case "signIn":
      return checkSignIn(s, dispatcher);
    case "gitlab":
      return checkGitlab(s, dispatcher);
    case "github":
      return checkGithub(s, dispatcher);
    case "models": {
      const gateway = gatewayOf(s);
      if (!gateway) {
        return Promise.resolve([
          { ok: false, title: "Model gateway", detail: "No gateway address.", fix: "Fill it in." },
        ]);
      }
      return checkModels(
        gateway,
        { top: s["models.top"], standard: s["models.standard"], light: s["models.light"] },
        dispatcher,
      );
    }
  }
}

const defined = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !!e[1]));

import type { Dispatcher } from "undici";
import { catalogOf } from "../../catalog.js";
import type { Db } from "../../db/client.js";
import { type DeepHealth, deepHealth } from "../../health.js";
import { startingModels } from "../../preferences.js";
import { parseModelId } from "../../shared/index.js";
import type { AppBindings } from "../../types.js";
import {
  type Check,
  checkGithub,
  checkGitlab,
  checkModels,
  checkSignIn,
  type Tiers,
} from "./checks.js";
import type { Settings } from "./settings.js";

// The server's health page: each part of the deployment tested as it runs
// now, the settings the environment set included, in plain words.

export type HealthSection = { title: string; checks: Check[] };

export type HealthContext = {
  db: Db;
  bindings: AppBindings;
  /** The variables the server runs with, saved settings included: the bots' keys are not bindings. */
  vars: Record<string, string | undefined>;
  /** Whether this server reviews pull requests, and whether remote runners do it. */
  autoReview: boolean;
  runners: boolean;
  mailer: boolean;
  dispatcher: Dispatcher;
  now: Date;
};

export async function healthReport(ctx: HealthContext): Promise<HealthSection[]> {
  const b = ctx.bindings;
  const s = settingsOf(ctx.vars);
  const deep = await deepHealth(ctx.db, ctx.runners, ctx.now);
  const [signIn, hosts, models] = await Promise.all([
    signInChecks(b, s, ctx.dispatcher),
    hostChecks(b, s, ctx.dispatcher),
    modelChecks(b, ctx.dispatcher),
  ]);
  return [
    { title: "Database", checks: databaseChecks(deep) },
    { title: "Sign-in", checks: signIn },
    { title: "Code hosts", checks: hosts },
    { title: "Models", checks: models },
    { title: "Reviews", checks: reviewChecks(ctx, deep) },
  ];
}

/** The settings the checks take, from the variables the server runs with. */
function settingsOf(v: Record<string, string | undefined>): Settings {
  const out: Settings = {};
  const put = (name: keyof Settings, value: string | undefined) => {
    if (value) out[name] = value;
  };
  put("signIn.issuer", v.OIDC_ISSUER);
  put("signIn.clientId", v.OIDC_CLIENT_ID);
  put("signIn.clientSecret", v.OIDC_CLIENT_SECRET);
  put("gitlab.url", v.GITLAB_URL?.replace(/\/+$/, ""));
  put("gitlab.botToken", v.GITLAB_BOT_TOKEN);
  put("github.url", v.GITHUB_URL);
  put("github.appId", v.GITHUB_APP_ID);
  put("github.appPrivateKey", v.GITHUB_APP_PRIVATE_KEY);
  return out;
}

function databaseChecks(deep: DeepHealth): Check[] {
  const title = "Database";
  if (deep.reasons.some((r) => r.startsWith("database_"))) {
    return [
      {
        ok: false,
        title,
        detail: deep.reasons.includes("database_timeout")
          ? "The database did not answer within five seconds."
          : "The database refused a query.",
        fix: "Check that the database runs and DATABASE_URL points to it: docker compose ps, docker compose logs postgres.",
      },
    ];
  }
  const out: Check[] = [{ ok: true, title, detail: "The database answers." }];
  const m = deep.migrations;
  if (deep.reasons.includes("migrations_missing") && m) {
    out.push({
      ok: false,
      title: "Migrations",
      detail: `${m.missing.length} of this version's ${m.expected} migrations are not applied.`,
      fix: "Run the upgrade again (selfhost/upgrade.sh), which applies them before the server starts.",
    });
  } else if (m && m.unknown > 0) {
    out.push({
      ok: false,
      title: "Migrations",
      detail: "A newer version of ocra Cloud migrated this database.",
      fix: "Run the newer version, or restore the backup taken before it.",
    });
  } else if (deep.reasons.some((r) => r.startsWith("migrations_"))) {
    out.push({
      ok: false,
      title: "Migrations",
      detail: "Which migrations are applied could not be read.",
      fix: "Check the server's log: docker compose logs ocra.",
    });
  } else if (m) {
    out.push({
      ok: true,
      title: "Migrations",
      detail: `All ${m.expected} migrations are applied.`,
    });
  }
  return out;
}

async function signInChecks(b: AppBindings, s: Settings, dispatcher: Dispatcher) {
  const out: Check[] = [];
  if (s["signIn.issuer"]) out.push(...(await checkSignIn(s, dispatcher)));
  if (b.GITHUB_CLIENT_ID && b.GITHUB_CLIENT_SECRET) {
    out.push({ ok: true, title: "GitHub sign-in", detail: "People may sign in with GitHub." });
  }
  if (out.length === 0) {
    out.push({
      ok: false,
      title: "Sign-in",
      detail: "Nobody can sign in: no single sign-on or GitHub App is set.",
      fix: "Set up single sign-on on the setup page.",
    });
  }
  if (!b.SIGN_IN_ALLOW) {
    out.push({
      ok: true,
      note: true,
      title: "Who may sign in",
      detail: "Anyone your sign-in provider vouches for.",
      fix: "To limit it, list groups, organizations or email domains under Sign-in.",
    });
  }
  return out;
}

async function hostChecks(b: AppBindings, s: Settings, dispatcher: Dispatcher) {
  const out: Check[] = [];
  if (s["gitlab.url"]) out.push(...(await checkGitlab(s, dispatcher)));
  if (b.GITHUB_CLIENT_ID || s["github.appId"]) out.push(...(await checkGithub(s, dispatcher)));
  if (out.length === 0) {
    out.push({
      ok: false,
      title: "Code hosts",
      detail: "No GitLab or GitHub is connected, so there is nothing to review.",
      fix: "Connect one on the setup page.",
    });
  }
  return out;
}

async function modelChecks(b: AppBindings, dispatcher: Dispatcher) {
  const company = catalogOf(b).entries.filter(([, p]) => p.group === "Company");
  const starting = startingModels(b);
  const out: Check[] = [];
  for (const [id, p] of company) {
    const tiers: Tiers = {};
    for (const tier of ["top", "standard", "light"] as const) {
      const ref = parseModelId(starting[tier]?.[0] ?? "");
      if (ref?.provider === id) tiers[tier] = ref.model;
    }
    const auth = p.routes[0]?.auth ?? "bearer";
    out.push(
      ...(await checkModels(
        { label: p.label, base: p.base, models: p.verify?.path, auth, key: p.sharedKey },
        tiers,
        dispatcher,
      )),
    );
  }
  if (company.length === 0) {
    out.push(
      catalogOf(b).entries.length > 0
        ? {
            ok: true,
            note: true,
            title: "Models",
            detail: "Each person brings a key of a public model provider.",
            fix: "To use your company's models instead, set the model gateway on the setup page.",
          }
        : {
            ok: false,
            title: "Models",
            detail: "No model provider is available, so no review can run.",
            fix: "Set the model gateway on the setup page.",
          },
    );
  }
  return out;
}

function reviewChecks(ctx: HealthContext, deep: DeepHealth): Check[] {
  const out: Check[] = [
    ctx.autoReview
      ? {
          ok: true,
          title: "Automatic reviews",
          detail: "This server reviews pull requests as its bot.",
        }
      : {
          ok: true,
          note: true,
          title: "Automatic reviews",
          detail: "Off: people review from their own machines and CI with the ocra CLI.",
          fix: "Give the code host a bot token (GitLab) or an App key (GitHub) to review pull requests here.",
        },
  ];
  if (ctx.runners) {
    out.push(
      deep.reasons.includes("runner_stale") || deep.runnerSeenAt === null
        ? {
            ok: false,
            title: "Review runners",
            detail: "No remote runner asked for work in the last five minutes, so reviews wait.",
            fix: "Start a runner, or check its log (docs/runner.md).",
          }
        : { ok: true, title: "Review runners", detail: "A remote runner asked for work lately." },
    );
  }
  if (!ctx.bindings.PUBLIC_URL) {
    out.push({
      ok: false,
      title: "Public address",
      detail: "The server does not know the address people open it at.",
      fix: "Set PUBLIC_URL (docker compose sets it from OCRA_DOMAIN).",
    });
  }
  out.push(
    ctx.mailer
      ? { ok: true, title: "Email", detail: "Notifications and digests go out by email." }
      : {
          ok: true,
          note: true,
          title: "Email",
          detail: "Off: nobody gets notifications by email.",
          fix: "Set SMTP_URL and SMTP_FROM to send them.",
        },
  );
  return out;
}

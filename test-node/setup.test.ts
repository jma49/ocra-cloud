import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT, companyCa, type GitlabInstance, gitlabInstance } from "./gitlab-instance.js";
import { KEY, MODEL, modelEndpoint } from "./model-endpoint.js";

// A server set up from its settings page, as an operator's first hour goes:
// started with nothing but its secrets, opened with the setup code from its
// log, its company network, sign-in, GitLab and models tested and saved,
// then started again in the same process, signing people in through GitLab.
// The certificate authority is given on the page only: the server trusts the
// instance and the model endpoint through it.

let dir: string;
let ca: ReturnType<typeof companyCa>;
let gitlab: GitlabInstance;
let model: Awaited<ReturnType<typeof modelEndpoint>>;
let server: ChildProcess;
let origin: string;
let logs = "";

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });

/** A browser's cookies on this server. */
function browser() {
  const jar = new Map<string, string>();
  return async (path: string, method = "GET", body?: unknown) => {
    const headers = new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
    if (method !== "GET") headers.set("origin", origin);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(new URL(path, origin), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
}

type Check = { ok: boolean; title: string; detail: string; fix?: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-setup-e2e-"));
  ca = companyCa(dir);
  gitlab = await gitlabInstance(dir, ca);
  model = await modelEndpoint(ca, {}, () => "{}");
  const bundle = resolve("dist/setup-e2e/server.mjs");
  await build({
    entryPoints: ["src/node/server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: bundle,
    logLevel: "silent",
  });
  const web = join(dir, "web");
  await mkdir(web);
  // The master key as Compose's generated secret gives it: a file.
  await writeFile(join(dir, "master_key"), `${Buffer.alloc(32, 5).toString("base64")}\n`);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: String(port),
      DATABASE_URL: `file:${join(dir, "ocra.db")}`,
      MIGRATIONS_DIR: resolve("migrations"),
      WEB_DIR: web,
      PUBLIC_URL: origin,
      MASTER_KEY_FILE: join(dir, "master_key"),
      SESSION_SECRET: "setup-e2e-secret",
      OIDC_NAME: "GitLab",
      CODE_GRAPH: "off",
    } as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => {
    logs += d;
  });
  server.stderr?.on("data", (d) => {
    logs += d;
  });
  await vi.waitFor(
    async () => {
      expect((await fetch(`${origin}/api/health`)).ok).toBe(true);
    },
    { timeout: 20_000, interval: 200 },
  );
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((done) => server.once("exit", done));
    server.kill("SIGTERM");
    await exited;
  }
  await Promise.all([gitlab?.close(), model?.close()]);
  await rm(dir, { recursive: true, force: true });
});

describe("setting up a server from its settings page", () => {
  const visit = browser();
  const settings = {
    "network.caCertificates": "",
    "signIn.issuer": "",
    "signIn.clientId": "ocra-app",
    "signIn.clientSecret": "app-secret",
    "gitlab.url": "",
    "gitlab.clientId": "ocra-app",
    "gitlab.clientSecret": "app-secret",
    "gitlab.botToken": BOT.token,
    "models.base": "",
    "models.key": KEY,
    "models.top": MODEL,
  };
  beforeAll(() => {
    settings["network.caCertificates"] = readFileSync(ca.caFile, "utf8");
    settings["signIn.issuer"] = gitlab.url;
    settings["gitlab.url"] = gitlab.url;
    settings["models.base"] = `${model.base}/v1`;
  });
  let startedAt = 0;

  it("starts with nobody able to sign in, and logs the setup code", async () => {
    const state = (await (await fetch(`${origin}/api/setup`)).json()) as {
      needed: boolean;
      startedAt: number;
    };
    expect(state.needed).toBe(true);
    startedAt = state.startedAt;
    expect(logs).toContain("setup_needed");
    expect(await (await fetch(`${origin}/api/auth/methods`)).json()).toEqual({ methods: [] });
  });

  it("opens the settings only with the code", async () => {
    expect((await visit("/api/setup/settings")).status).toBe(401);
    expect((await visit("/api/setup/unlock", "POST", { code: "0000-0000-0000-0000" })).status).toBe(
      401,
    );
    const code = logs.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)?.[0] ?? "";
    // As people type it: any case, without dashes.
    const typed = code.toLowerCase().replaceAll("-", "");
    expect((await visit("/api/setup/unlock", "POST", { code: typed })).status).toBe(200);
    expect((await visit("/api/setup/settings")).status).toBe(200);
  });

  it("says plainly that the company's authority is missing, then reaches GitLab through it", async () => {
    const { "network.caCertificates": _, ...withoutCa } = settings;
    const before = (await (
      await visit("/api/setup/check", "POST", { step: "gitlab", values: withoutCa })
    ).json()) as { checks: Check[] };
    expect(before.checks[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("does not trust the certificate"),
      fix: expect.stringContaining("certificate authority under Network"),
    });
    const after = (await (
      await visit("/api/setup/check", "POST", { step: "gitlab", values: settings })
    ).json()) as { checks: Check[] };
    expect(after.checks).toEqual([
      expect.objectContaining({ ok: true, title: "GitLab" }),
      expect.objectContaining({ ok: true, detail: `The token signs in as @${BOT.username}.` }),
    ]);
  });

  it("tests sign-in and the models, naming a model the gateway does not list", async () => {
    const signIn = (await (
      await visit("/api/setup/check", "POST", { step: "signIn", values: settings })
    ).json()) as { checks: Check[] };
    expect(signIn.checks.every((c) => c.ok)).toBe(true);
    const models = (await (
      await visit("/api/setup/check", "POST", {
        step: "models",
        values: { ...settings, "models.light": "not-a-model" },
      })
    ).json()) as { checks: Check[] };
    expect(models.checks).toEqual([
      expect.objectContaining({ ok: true, detail: expect.stringContaining("lists 1 models") }),
      expect.objectContaining({ ok: true, title: "The top model" }),
      expect.objectContaining({ ok: false, detail: "The endpoint does not list not-a-model." }),
    ]);
  });

  it("refuses a setting the environment sets, and a malformed one", async () => {
    const res = await visit("/api/setup/settings", "PUT", {
      values: { "signIn.name": "SSO", "signIn.issuer": "not a url" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issues: expect.arrayContaining([
        { path: ["signIn.name"], message: "set by OIDC_NAME in the server's environment" },
        { path: ["signIn.issuer"], message: "an address starting with https://" },
      ]),
    });
  });

  it("saves the settings, never showing a secret again", async () => {
    const res = await visit("/api/setup/settings", "PUT", { values: settings });
    expect(res.status).toBe(200);
    const shown = JSON.stringify(await (await visit("/api/setup/settings")).json());
    for (const secret of ["app-secret", BOT.token, KEY]) expect(shown).not.toContain(secret);
    expect(JSON.parse(shown).fields["gitlab.botToken"]).toEqual({ set: true });
  });

  it("starts again with them, in the same process, and signs people in through GitLab", async () => {
    expect(await (await visit("/api/setup/apply", "POST", {})).json()).toEqual({
      restarting: true,
    });
    await vi.waitFor(
      async () => {
        const state = (await (await fetch(`${origin}/api/setup`)).json()) as {
          needed: boolean;
          startedAt: number;
        };
        expect(state.startedAt).toBeGreaterThan(startedAt);
        expect(state.needed).toBe(false);
      },
      { timeout: 20_000, interval: 200 },
    );
    expect(server.exitCode).toBeNull();
    expect(await (await fetch(`${origin}/api/auth/methods`)).json()).toEqual({
      methods: [{ id: "oidc", name: "GitLab" }],
    });
    const login = await fetch(`${origin}/api/auth/oidc/login`, { redirect: "manual" });
    expect(login.headers.get("location")).toMatch(`${gitlab.url}/oauth/authorize?`);
  });

  it("reports every part healthy, through the saved authority", async () => {
    const report = (await (await visit("/api/setup/health")).json()) as {
      sections: { title: string; checks: Check[] }[];
    };
    const failed = report.sections.flatMap((s) => s.checks.filter((c) => !c.ok));
    expect(failed).toEqual([]);
    expect(report.sections.map((s) => s.title)).toEqual([
      "Database",
      "Sign-in",
      "Code hosts",
      "Models",
      "Reviews",
    ]);
  });
});

import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repoIdentity } from "../src/platforms/platform.js";
import {
  APP,
  BOT_TOKEN,
  type githubEnterprise as GithubEnterprise,
  githubEnterprise,
  PERSON,
  PR,
  REPO,
} from "./github-enterprise.js";
import { companyCa } from "./gitlab-repository.js";
import { KEY, MODEL, modelEndpoint } from "./model-endpoint.js";

// The company deployment on GitHub Enterprise Server, end to end: the built
// server in its own process, GITHUB_URL naming a server with its own
// certificate authority, signing a person in with the server's GitHub App,
// listing what the App reaches, and reviewing an opened pull request with
// the bot's installation token, the released CLI and the company's model.
// The server and the model are the only stand-ins.

const RUN_MS = 120_000;
const FINDING = {
  file: "retry.ts",
  existingCode: "  return limit - 1;",
  severity: "warning",
  title: "Off-by-one in retries",
  body: "A limit of 1 now allows no retry at all.",
};
const HOOK_SECRET = "ghes-hook-secret";

let dir: string;
let ca: ReturnType<typeof companyCa>;
let ghes: Awaited<ReturnType<typeof GithubEnterprise>>;
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

/** The server's redirect for a browser on its authorize page. */
const authorize = (url: string) =>
  new Promise<string>((done, fail) => {
    request(url, { ca: ca.ca }, (res) => {
      res.resume();
      done(res.headers.location ?? "");
    })
      .on("error", fail)
      .end();
  });

function browser() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET") headers.set("origin", origin);
    const res = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-ghes-e2e-"));
  ca = companyCa(dir);
  ghes = await githubEnterprise(dir, ca);
  model = await modelEndpoint(ca, FINDING, (prompt) => (prompt.includes("verdict") ? "[]" : "{}"));
  const bundle = resolve("dist/e2e/ghes-server.mjs");
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
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  server = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: String(port),
      DATABASE_URL: `file:${join(dir, "ocra.db")}`,
      MIGRATIONS_DIR: resolve("migrations"),
      WEB_DIR: web,
      PUBLIC_URL: origin,
      MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
      SESSION_SECRET: "ghes-session-secret",
      GITHUB_URL: ghes.url,
      GITHUB_CLIENT_ID: "ghes-app",
      GITHUB_CLIENT_SECRET: "ghes-secret",
      GITHUB_APP_SLUG: APP.slug,
      GITHUB_APP_ID: String(APP.id),
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: HOOK_SECRET,
      MODEL_ENDPOINTS: JSON.stringify([
        { id: "corp", label: "Corp LLM", base: model.base, models: "/v1/models", key: KEY },
      ]),
      BUILTIN_PROVIDERS: "off",
      DEFAULT_MODELS: JSON.stringify({
        top: [`ocra-corp/${MODEL}`],
        standard: [`ocra-corp/${MODEL}`],
        light: `ocra-corp/${MODEL}`,
      }),
      CODE_GRAPH: "off",
      NODE_EXTRA_CA_CERTS: ca.caFile,
      GIT_SSL_CAINFO: ca.caFile,
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
  await Promise.all([ghes?.close(), model?.close()]);
  await rm(dir, { recursive: true, force: true });
});

describe("ocra Cloud with GitHub Enterprise Server", () => {
  const visit = browser();
  const send = (path: string, method: string, body: unknown) =>
    visit(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("signs a person in with the server's GitHub App, on the server", async () => {
    const login = await visit("/api/auth/github/login");
    const to = new URL(login.headers.get("location") ?? "");
    expect(to.toString()).toMatch(`${ghes.url}/login/oauth/authorize?`);
    const back = new URL(await authorize(to.toString()));
    expect((await visit(back.pathname + back.search)).status).toBe(302);
    expect(await (await visit("/api/me")).json()).toMatchObject({
      login: PERSON.login,
      githubId: PERSON.id,
      githubUrl: ghes.url,
      avatarUrl: null,
    });
    const asked = ghes.requests.map((r) => `${r.method} ${r.path}`);
    expect(asked).toContain("POST /login/oauth/access_token");
    expect(asked).toContain("GET /api/v3/user");
  });

  it("lists the repositories the App reaches, under the server's address", async () => {
    const listed = (await (await visit("/api/platforms/repos")).json()) as {
      platforms: {
        platform: string;
        url: string;
        linked: boolean;
        host: string;
        installUrl?: string;
        repositories: { fullName: string; url: string }[];
      }[];
    };
    expect(listed.platforms).toEqual([
      expect.objectContaining({
        platform: "github",
        linked: true,
        host: new URL(ghes.url).host,
        installUrl: `${ghes.url}/apps/${APP.slug}/installations/new`,
        repositories: [
          expect.objectContaining({ fullName: REPO.fullName, url: `${ghes.url}/${REPO.fullName}` }),
        ],
      }),
    ]);
  });

  it(
    "reviews an opened pull request as the App's bot, through the server's API",
    async () => {
      const enrolled = await send("/api/auto-review/repos", "POST", {
        platform: "github",
        fullName: REPO.fullName,
      });
      expect(enrolled.status, await enrolled.clone().text()).toBe(200);
      const payload = JSON.stringify({
        action: "opened",
        number: PR,
        pull_request: {
          draft: false,
          head: { sha: ghes.head },
          title: "Count retries from zero",
          user: { login: PERSON.login },
          base: { ref: "main" },
        },
        repository: { id: REPO.id, full_name: REPO.fullName },
      });
      const hook = await fetch(`${origin}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${createHmac("sha256", HOOK_SECRET).update(payload).digest("hex")}`,
        },
        body: payload,
      });
      expect(await hook.json()).toEqual({ queued: 1 });
      const reviewPosted = () =>
        ghes.requests.find(
          (r) =>
            r.method === "POST" &&
            r.path === `/api/v3/repos/${REPO.fullName}/pulls/${PR}/reviews` &&
            r.authorization === `Bearer ${BOT_TOKEN}`,
        );
      await vi.waitFor(
        () =>
          expect(
            reviewPosted(),
            `${logs}\n${ghes.requests.map((r) => `${r.method} ${r.path}`).join("\n")}`,
          ).toBeDefined(),
        {
          timeout: RUN_MS,
          interval: 500,
        },
      );
      expect(JSON.stringify(reviewPosted()?.body)).toContain(FINDING.title);
      expect(new Set(model.keys)).toEqual(new Set([`Bearer ${KEY}`]));
      // The bot cloned from the server with its installation token.
      expect(ghes.requests.some((r) => r.path === `/${REPO.fullName}.git/info/refs`)).toBe(true);
      // Every GitHub call went to the server's own paths.
      const paths = ghes.requests.map((r) => r.path);
      expect(
        paths.filter(
          (p) =>
            !/^\/(api\/v3\/|api\/graphql$|login\/oauth\/)/.test(p) &&
            !p.startsWith(`/${REPO.fullName}.git/`),
        ),
      ).toEqual([]);
      await vi.waitFor(
        async () => {
          const listed = (await (await visit("/api/reviews")).json()) as {
            reviews: { prRepository: string | null; prNumber: number | null }[];
          };
          expect(listed.reviews).toEqual([
            expect.objectContaining({
              prRepository: repoIdentity({ url: ghes.url }, REPO.fullName),
              prNumber: PR,
            }),
          ]);
        },
        { timeout: 15_000, interval: 250 },
      );
    },
    RUN_MS + 10_000,
  );
});

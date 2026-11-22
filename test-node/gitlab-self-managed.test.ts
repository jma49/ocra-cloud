import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repoIdentity } from "../src/platforms/platform.js";
import {
  BOT,
  companyCa,
  type GitlabInstance,
  gitlabInstance,
  MR,
  PERSON,
  PROJECT,
} from "./gitlab-instance.js";
import { KEY, MODEL, modelEndpoint } from "./model-endpoint.js";

// The company deployment end to end: the built server in its own process,
// signing people in through a self-managed GitLab (its own certificate
// authority, under /gitlab), reviewing a merge request with the released
// CLI and the company's model, and answering an @ocra comment. Nothing is
// faked inside ocra: the instance and the model are the only stand-ins.

const RUN_MS = 120_000;
const FINDING = {
  file: "retry.ts",
  existingCode: "  return limit - 1;",
  severity: "warning",
  title: "Off-by-one in retries",
  body: "A limit of 1 now allows no retry at all.",
};
const QUESTION = "why is this a problem?";
const ANSWER = "Because a limit of 1 must still allow one retry.";

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

/** The instance's redirect for a browser on its authorize page: where it sends the browser back. */
const authorize = (url: string) =>
  new Promise<string>((done, fail) => {
    request(url, { ca: ca.ca }, (res) => {
      res.resume();
      done(res.headers.location ?? "");
    })
      .on("error", fail)
      .end();
  });

/** A browser's cookies on this server. */
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
  dir = await mkdtemp(join(tmpdir(), "ocra-gitlab-e2e-"));
  ca = companyCa(dir);
  gitlab = await gitlabInstance(dir, ca);
  model = await modelEndpoint(ca, FINDING, (prompt) =>
    prompt.includes(QUESTION) ? ANSWER : prompt.includes("verdict") ? "[]" : "{}",
  );
  const bundle = resolve("dist/e2e/server.mjs");
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
  server = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: String(port),
      DATABASE_URL: `file:${join(dir, "ocra.db")}`,
      MIGRATIONS_DIR: resolve("migrations"),
      WEB_DIR: web,
      PUBLIC_URL: origin,
      MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      SESSION_SECRET: "e2e-session-secret",
      OIDC_ISSUER: gitlab.url,
      // One GitLab application signs people in and connects GitLab.
      OIDC_CLIENT_ID: "ocra-app",
      OIDC_CLIENT_SECRET: "app-secret",
      OIDC_NAME: "GitLab",
      GITLAB_URL: gitlab.url,
      GITLAB_CLIENT_ID: "ocra-app",
      GITLAB_CLIENT_SECRET: "app-secret",
      GITLAB_BOT_TOKEN: BOT.token,
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
      // The company's certificate authority, which Node and git each read.
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
  server?.kill("SIGTERM");
  await Promise.all([gitlab?.close(), model?.close()]);
  await rm(dir, { recursive: true, force: true });
});

describe("ocra Cloud with a self-managed GitLab", () => {
  const visit = browser();
  let secret = "";

  it("signs a person in with the instance's OpenID Connect, which connects their GitLab too", async () => {
    const login = await visit("/api/auth/oidc/login");
    const to = new URL(login.headers.get("location") ?? "");
    expect(to.toString()).toMatch(`${gitlab.url}/oauth/authorize?`);
    expect(to.searchParams.get("scope")).toBe("openid profile email api");
    const back = new URL(await authorize(to.toString()));
    expect((await visit(back.pathname + back.search)).status).toBe(302);
    expect(await (await visit("/api/me")).json()).toMatchObject({ login: PERSON.username });
    const listed = (await (await visit("/api/platforms/repos")).json()) as {
      platforms: { platform: string; linked: boolean }[];
    };
    expect(listed.platforms).toEqual([
      expect.objectContaining({ platform: "gitlab", linked: true }),
    ]);
  });

  it("enrolls the project for review and gives the hook's address and secret", async () => {
    const res = await visit("/api/auto-review/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "gitlab", fullName: PROJECT.path }),
    });
    const body = (await res.json()) as { webhook: { url: string; secret: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.webhook.url).toBe(`${origin}/api/auto-review/webhooks/gitlab`);
    secret = body.webhook.secret;
  });

  it(
    "reviews an opened merge request as the bot, with the company's model",
    async () => {
      const hook = await fetch(`${origin}/api/auto-review/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": "Merge Request Hook",
          "x-gitlab-token": secret,
        },
        body: JSON.stringify({
          object_kind: "merge_request",
          user: { username: PERSON.username },
          project: { id: PROJECT.id, path_with_namespace: PROJECT.path },
          object_attributes: {
            iid: MR,
            action: "open",
            draft: false,
            last_commit: { id: gitlab.head },
            title: "Count retries from zero",
            target_branch: "main",
          },
        }),
      });
      expect(await hook.json()).toEqual({ queued: 1 });
      await vi.waitFor(
        () => {
          const notes = gitlab.discussions.flatMap((d) => d.notes);
          expect(
            notes.some((n) => n.body.includes("<!-- ocra:review -->")),
            logs,
          ).toBe(true);
        },
        { timeout: RUN_MS, interval: 500 },
      );
      const inline = gitlab.discussions.find((d) => d.notes[0]?.type === "DiffNote");
      expect(inline?.notes[0]).toMatchObject({
        author: { username: BOT.username },
        position: { new_path: "retry.ts", new_line: 2, head_sha: gitlab.head },
      });
      expect(inline?.notes[0]?.body).toContain(FINDING.title);
      // The model was called by the server's gateway only, with the server's key.
      expect(model.chats.length).toBeGreaterThan(0);
      expect(new Set(model.keys)).toEqual(new Set([`Bearer ${KEY}`]));
      // The upload names the merge request as the server names the project, so the
      // pull request's page and its pre-merge checks find this review. The CLI
      // uploads after it posts, so the review may land a moment later.
      await vi.waitFor(
        async () => {
          const listed = (await (await visit("/api/reviews")).json()) as {
            reviews: { prRepository: string | null; prNumber: number | null }[];
          };
          expect(listed.reviews).toEqual([
            expect.objectContaining({
              prRepository: repoIdentity({ url: gitlab.url }, PROJECT.path),
              prNumber: MR,
            }),
          ]);
        },
        { timeout: 15_000, interval: 250 },
      );
      // The bot cloned over HTTPS under the instance's path, with its own token.
      expect(gitlab.requests.some((r) => r.path.endsWith(`/${PROJECT.path}.git/info/refs`))).toBe(
        true,
      );
    },
    RUN_MS + 10_000,
  );

  it(
    "answers a person's @ocra comment in its thread",
    async () => {
      const asked = gitlab.comment(`@ocra ${QUESTION}`);
      const hook = await fetch(`${origin}/api/auto-review/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": "Note Hook",
          "x-gitlab-token": secret,
        },
        body: JSON.stringify({
          object_kind: "note",
          user: { username: PERSON.username },
          project: { id: PROJECT.id },
          object_attributes: { id: asked.id, note: asked.body, noteable_type: "MergeRequest" },
          merge_request: { iid: MR },
        }),
      });
      expect(await hook.json()).toEqual({ queued: 1 });
      await vi.waitFor(
        () => {
          const thread = gitlab.discussions.find((d) => d.notes[0]?.id === asked.id);
          expect(thread?.notes.at(-1)?.body ?? "", logs).toContain(ANSWER);
        },
        { timeout: RUN_MS, interval: 500 },
      );
    },
    RUN_MS + 10_000,
  );
});

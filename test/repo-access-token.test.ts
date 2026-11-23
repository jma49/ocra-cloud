import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { remoteReviews } from "../src/auto-review/remote.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { platformsOf } from "../src/platforms/registry.js";
import { type CallInit, db, ORIGIN, request, resetDb, signIn } from "./helpers.js";

// A GitLab project enrolled on a server without GITLAB_BOT_TOKEN gets its
// own project or group access token: checked with GitLab once, sealed in
// its row, handed to a runner only for that project's jobs, never answered
// or exported.

const RUNNER = "runner-token-of-at-least-32-characters";
const TOKEN = "glpat-project-token-secret-value";
const BOT = { id: 501, username: "project_11_bot_4f2a", bot: true };
const lab = platformsOf(env, ORIGIN).find((p) => p.kind === "gitlab");
const API = `${lab?.url}/api/v4`;

const vars = {
  GITLAB_CLIENT_ID: env.GITLAB_CLIENT_ID,
  GITLAB_CLIENT_SECRET: env.GITLAB_CLIENT_SECRET,
  MASTER_KEY: env.MASTER_KEY,
  RUNNER_TOKEN: RUNNER,
};
const app = createApp({
  openDb: (bindings: typeof env) => drizzle(bindings.DB),
  clientAddress: () => "203.0.113.9",
  ...remoteReviews(vars),
});

async function send(path: string, init: CallInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const asRunner = (path: string, json: unknown) =>
  send(`/api/runner/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${RUNNER}` },
    json,
  });

type Gitlab = { user?: Record<string, unknown> | number; scopes?: string[]; level?: number };

/** GitLab as each token sees it: TOKEN a project bot's, anything else as given. */
function gitlab(answers: Record<string, Gitlab>) {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    asked.push(url);
    const a = answers[auth];
    if (!a) return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    if (url === `${API}/user`) {
      return typeof a.user === "number"
        ? new Response(null, { status: a.user })
        : Response.json(a.user ?? BOT);
    }
    if (url === `${API}/personal_access_tokens/self`) {
      return Response.json({ scopes: a.scopes ?? ["api"] });
    }
    if (url.startsWith(`${API}/projects/11/members/all/`)) {
      return a.level === undefined
        ? new Response(null, { status: 404 })
        : Response.json({ access_level: a.level });
    }
    return new Response(null, { status: 404 });
  });
  return asked;
}

let a: Awaited<ReturnType<typeof signIn>>;
let b: Awaited<ReturnType<typeof signIn>>;
let repoId: string;

beforeEach(async () => {
  await resetDb();
  a = await signIn(1, "user-a");
  b = await signIn(2, "user-b");
  const jobs = scoped(db, a.account.id).autoReview;
  repoId =
    (await jobs.enroll(
      { platform: "gitlab", host: lab?.host ?? "", platformRepoId: "11", fullName: "acme/api" },
      100,
    )) ?? "";
});
afterEach(() => vi.restoreAllMocks());

const put = (auth: Record<string, string>, token: string, id = repoId) =>
  send(`/api/auto-review/repos/${id}/access-token`, {
    method: "PUT",
    auth,
    json: { token },
  });

describe("an enrolled GitLab project's own access token", () => {
  it("turns hosted reviews on for GitLab without GITLAB_BOT_TOKEN", () => {
    expect(remoteReviews(vars)).toMatchObject({ autoReview: { remote: true } });
    expect(
      remoteReviews({ ...vars, GITLAB_CLIENT_ID: undefined, GITLAB_CLIENT_SECRET: undefined }),
    ).toEqual({});
  });

  it("is checked with GitLab, sealed, and answered only as its bot's username", async () => {
    gitlab({ [TOKEN]: { level: 30 } });
    const res = await put(a.auth, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasAccessToken: true, accessTokenBot: "project_11_bot_4f2a" });
    const [row] = await db.select().from(schema.reviewRepos);
    expect(row?.accessTokenCiphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const listed = await send("/api/auto-review/repos", { auth: a.auth });
    expect(listed.body).toMatchObject({
      repos: [{ id: repoId, hasAccessToken: true, accessTokenBot: "project_11_bot_4f2a" }],
    });
    expect(listed.text).not.toContain(TOKEN);
    expect(listed.text).not.toContain(row?.accessTokenCiphertext ?? "-");
    const exported = await send("/api/export", { auth: a.auth });
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("acme/api");
    expect(exported.text).not.toContain(TOKEN);
    expect(exported.text).not.toContain(row?.accessTokenCiphertext ?? "-");
    expect(exported.text).not.toContain(row?.accessTokenWrappedKey ?? "-");
    const audit = await send("/api/audit", { auth: a.auth });
    expect(audit.text).toContain("auto_review.access_token_set");
    expect(audit.text).not.toContain(TOKEN);
  });

  it("refuses a person's token, a token GitLab refuses, a missing scope or role", async () => {
    gitlab({
      "glpat-person": { user: { id: 7, username: "alice", bot: false }, level: 40 },
      "glpat-readonly": { scopes: ["read_api"], level: 30 },
      "glpat-reporter": { level: 20 },
    });
    for (const [token, message] of [
      ["glpat-person", /a person's/],
      ["glpat-revoked", /GitLab refused/],
      ["glpat-readonly", /scope api/],
      ["glpat-reporter", /Developer/],
    ] as const) {
      const res = await put(a.auth, token);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_body", issues: [{ path: ["token"] }] });
      expect(res.body.issues[0].message).toMatch(message);
      expect(res.text).not.toContain(token);
    }
    const [row] = await db.select().from(schema.reviewRepos);
    expect(row?.accessTokenCiphertext).toBeNull();
  });

  it("is set, read and cleared only by the account that enrolled the project", async () => {
    gitlab({ [TOKEN]: { level: 30 } });
    expect((await put(b.auth, TOKEN)).status).toBe(404);
    expect((await put(a.auth, TOKEN)).status).toBe(200);
    const theirs = await send("/api/auto-review/repos", { auth: b.auth });
    expect(theirs.body).toEqual({ repos: [] });
    const cleared = await send(`/api/auto-review/repos/${repoId}/access-token`, {
      method: "DELETE",
      auth: b.auth,
    });
    expect(cleared.status).toBe(404);
    expect((await scoped(db, b.account.id).get("reviewRepos", repoId))?.id).toBeUndefined();
    const [row] = await db.select().from(schema.reviewRepos);
    expect(row?.accessTokenCiphertext).toBeTruthy();
  });

  it("is deleted when cleared, and with the project when it is unenrolled", async () => {
    gitlab({ [TOKEN]: { level: 30 } });
    await put(a.auth, TOKEN);
    const cleared = await send(`/api/auto-review/repos/${repoId}/access-token`, {
      method: "DELETE",
      auth: a.auth,
    });
    expect(cleared.body).toEqual({ hasAccessToken: false, accessTokenBot: null });
    const [row] = await db.select().from(schema.reviewRepos);
    expect(row).toMatchObject({
      accessTokenWrappedKey: null,
      accessTokenCiphertext: null,
      accessTokenBot: null,
    });
    await put(a.auth, TOKEN);
    await send(`/api/auto-review/repos/${repoId}`, { method: "DELETE", auth: a.auth });
    expect(await db.select().from(schema.reviewRepos)).toEqual([]);
  });

  it("is handed to a runner for that project's job only", async () => {
    gitlab({ [TOKEN]: { level: 30 } });
    await put(a.auth, TOKEN);
    const other =
      (await scoped(db, b.account.id).autoReview.enroll(
        { platform: "gitlab", host: lab?.host ?? "", platformRepoId: "12", fullName: "acme/web" },
        100,
      )) ?? "";
    await scoped(db, a.account.id).autoReview.queue(repoId, 7, "c".repeat(40), new Date());
    await scoped(db, b.account.id).autoReview.queue(other, 8, "d".repeat(40), new Date());
    const first = await asRunner("claim", { name: "mini", version: "0.14.0" });
    const second = await asRunner("claim", { name: "mini", version: "0.14.0" });
    const assignments = [first.body.assignment, second.body.assignment].filter(Boolean);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      accountId: a.account.id,
      repo: { fullName: "acme/api" },
      bot: { token: TOKEN },
    });
    expect(second.text).not.toContain(TOKEN);
    const jobs = await db.select().from(schema.reviewJobs);
    expect(jobs.find((j) => j.reviewRepoId === other)).toMatchObject({
      state: "failed",
      error: "no_bot",
    });
  });

  it("fails the project's jobs at once when GitLab no longer takes it", async () => {
    gitlab({ [TOKEN]: { level: 30 } });
    await put(a.auth, TOKEN);
    vi.restoreAllMocks();
    gitlab({});
    await scoped(db, a.account.id).autoReview.queue(repoId, 7, "c".repeat(40), new Date());
    const claimed = await asRunner("claim", { name: "mini", version: "0.14.0" });
    expect(claimed.body.assignment).toBeNull();
    const [job] = await db.select().from(schema.reviewJobs);
    expect(job).toMatchObject({ state: "failed", error: "token_rejected" });
    expect(job?.notBefore ?? null).toBeNull();
  });
});

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CallBudget, withCalls } from "../src/calls.js";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { retryInbound } from "../src/inbound/run.js";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { accessToken, saveToken } from "../src/platforms/links.js";
import { githubClientOf } from "../src/platforms/registry.js";
import {
  type AutoEnrollInstallationsView,
  type BulkEnrollView,
  MAX_BULK_ENROLL,
} from "../src/shared/index.js";
import { signIn as account, db, request, resetDb } from "./helpers.js";

// Enrolling many repositories of the user's GitHub App installations at
// once, and the repositories later added to an installation whose switch
// the account turned on: each read as the account's user, each enrolled
// for one account only.

const SECRET = "auto-enroll-secret";
const HEAD = "1".repeat(40);
/** Repositories the user reaches, by lowercased name: GitHub's id. */
const REACHED = new Map(
  ["octo/api", "octo/web", "octo/cli", ...Array.from({ length: 14 }, (_, i) => `octo/r${i}`)].map(
    (name, i) => [name, 100 + i],
  ),
);

/** GitHub as the user's token reads it; the calls it was asked. */
function githubFake() {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    calls.push(url);
    if (url.startsWith(`${GITHUB_COM.api}/user/installations`)) {
      return Response.json({ installations: [{ id: 7, account: { login: "octo" } }] });
    }
    const repo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1];
    const id = repo && REACHED.get(repo.toLowerCase());
    if (repo && id) return Response.json({ id, full_name: repo, default_branch: "main" });
    if (/\/branches\/main$/.test(url)) return Response.json({ commit: { sha: HEAD } });
    return new Response(null, { status: 404 });
  });
  return calls;
}

const app = createApp({
  openDb: (e: Env) => drizzle(e.DB),
  clientAddress: () => "192.0.2.1",
  githubWebhookSecret: SECRET,
  autoReview: { kick: () => {} },
});
const client = githubClientOf(env);
if (!client) throw new Error("the test bindings configure GitHub");
const platform = github(client);

/** Calls the app and waits for what it runs after its answer. */
async function send(
  path: string,
  init: RequestInit & { json?: unknown; auth?: Record<string, string> },
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), env, ctx);
  const body = await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: res.status });
}

/** A signed-in account whose GitHub link reads as its user. */
async function signIn(n: number) {
  const me = await account(n, `user-${n}`);
  const data = scoped(db, me.account.id);
  await saveToken(data, env, platform, { access_token: `ghu_${n}` });
  return { ...me, data };
}

let calls: string[];
beforeEach(async () => {
  await resetDb();
  await db.delete(schema.inboundEvents);
  calls = githubFake();
});
afterEach(() => vi.restoreAllMocks());

const bulk = (auth: Record<string, string>, json: Record<string, unknown>) =>
  send("/api/auto-review/repos/bulk", { method: "POST", auth, json });

const optIn = (auth: Record<string, string>, id: string, json: Record<string, unknown>) =>
  send(`/api/auto-review/installations/${id}/auto-enroll`, { method: "PUT", auth, json });

async function added(names: string[], installation = 7) {
  const body = JSON.stringify({
    action: "added",
    installation: { id: installation },
    repositories_added: names.map((full_name) => ({
      id: REACHED.get(full_name.toLowerCase()) ?? 999,
      full_name,
    })),
  });
  return send("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "installation_repositories",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

const enrolled = async () =>
  (await db.select().from(schema.reviewRepos))
    .map((r) => [r.accountId, r.fullName, r.automatic] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));

describe("a bulk enrollment", () => {
  it("enrolls each repository the user reaches, and says of each how it went", async () => {
    const me = await signIn(1);
    const other = await signIn(2);
    expect((await bulk(other.auth, { fullNames: ["octo/cli"] })).status).toBe(200);

    const res = await bulk(me.auth, {
      fullNames: ["octo/api", "Octo/API", "octo/web", "octo/hidden", "octo/cli"],
      automatic: true,
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as BulkEnrollView;
    expect(results.map((r) => [r.fullName, r.outcome, "reason" in r ? r.reason : null])).toEqual([
      ["octo/api", "enrolled", null],
      ["octo/web", "enrolled", null],
      ["octo/hidden", "refused", "not_found"],
      ["octo/cli", "refused", "taken"],
    ]);
    expect(results[0]).toMatchObject({ repo: { fullName: "octo/api", automatic: true } });

    const again = (await (
      await bulk(me.auth, { fullNames: ["octo/api"] })
    ).json()) as BulkEnrollView;
    expect(again.results).toMatchObject([{ outcome: "already", repo: { automatic: true } }]);
    expect(await enrolled()).toEqual([
      [me.account.id, "octo/api", true],
      [other.account.id, "octo/cli", false],
      [me.account.id, "octo/web", true],
    ]);
  });

  it("names at most MAX_BULK_ENROLL repositories, each a repository path", async () => {
    const me = await signIn(1);
    const many = Array.from({ length: MAX_BULK_ENROLL + 1 }, (_, i) => `octo/r${i}`);
    const res = await bulk(me.auth, { fullNames: many });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(calls).toEqual([]);
    expect((await bulk(me.auth, { fullNames: ["../etc"] })).status).toBe(400);
  });
});

describe("enrolling an installation's new repositories", () => {
  it("is one account's switch, on an installation the user reaches", async () => {
    const me = await signIn(1);
    const other = await signIn(2);
    expect((await optIn(me.auth, "8", { enabled: true })).status).toBe(404);
    const on = await optIn(me.auth, "7", { enabled: true, automatic: true });
    expect(await on.json()).toEqual({ id: "7", owner: "octo", enabled: true, automatic: true });
    const theirs = await optIn(other.auth, "7", { enabled: true });
    expect(theirs.status).toBe(400);
    const listed = async (auth: Record<string, string>) =>
      (await (
        await send("/api/auto-review/installations", { auth })
      ).json()) as AutoEnrollInstallationsView;
    expect(await listed(me.auth)).toEqual({
      installations: [{ id: "7", owner: "octo", enabled: true, automatic: true }],
      more: false,
    });
    expect((await listed(other.auth)).installations).toMatchObject([{ enabled: false }]);
    // Off, it is the other account's to take.
    await optIn(me.auth, "7", { enabled: false });
    expect((await optIn(other.auth, "7", { enabled: true })).status).toBe(200);
  });

  it("enrolls the repositories added to it for that account, as its user reaches them", async () => {
    const me = await signIn(1);
    const other = await signIn(2);
    await bulk(other.auth, { fullNames: ["octo/cli"] });
    await optIn(me.auth, "7", { enabled: true, automatic: true });
    expect((await added(["octo/api", "octo/hidden", "octo/cli"])).status).toBe(202);
    expect(await enrolled()).toEqual([
      [me.account.id, "octo/api", true],
      [other.account.id, "octo/cli", false],
    ]);
    const audit = await scoped(db, me.account.id).find("auditEvents", {
      kind: "auto_review.enrolled",
    });
    expect(audit).toHaveLength(1);
  });

  it("enrolls nothing for an installation no account turned it on for", async () => {
    await signIn(1);
    expect((await added(["octo/api"])).status).toBe(202);
    expect(await db.select().from(schema.inboundEvents)).toEqual([]);
    expect(await enrolled()).toEqual([]);
  });

  it("enrolls many within the calls it may make, and the sweep goes on from there", async () => {
    const me = await signIn(1);
    await optIn(me.auth, "7", { enabled: true });
    const names = Array.from({ length: 14 }, (_, i) => `octo/r${i}`);
    expect((await added(names)).status).toBe(202);
    // Ten in the webhook's request: a refresh's call and two reads each.
    expect(await enrolled()).toHaveLength(10);
    const [row] = await db.select().from(schema.inboundEvents);
    expect(row?.state).toBe("pending");
    const later = () => new Date(Date.now() + 10 * 60_000);
    const runner = { db: db, env, bots: undefined };
    // A sweep with five calls left enrolls two and gives the rest back, the attempt not counted.
    const sweep = (calls: CallBudget) => withCalls(calls, () => retryInbound(runner, later, calls));
    await sweep(new CallBudget(5));
    expect(await enrolled()).toHaveLength(12);
    const [given] = await db.select().from(schema.inboundEvents);
    expect(given).toMatchObject({ state: "pending", attempts: 1 });
    await sweep(new CallBudget(45));
    expect(await enrolled()).toHaveLength(14);
    const [done] = await db.select().from(schema.inboundEvents);
    expect(done?.state).toBe("done");
    expect(
      (await enrolled()).every(([account, , automatic]) => account === me.account.id && !automatic),
    ).toBe(true);
  });
});

describe("an account's link to GitHub", () => {
  it("stands when the run's calls refused its refresh, which was never sent", async () => {
    const me = await signIn(1);
    await saveToken(me.data, env, platform, {
      access_token: "ghu_old",
      refresh_token: "ghr_old",
      expires_in: 0,
    });
    const token = await withCalls(new CallBudget(0), () => accessToken(me.data, env, platform));
    expect(token).toBeNull();
    expect(await me.data.count("platformLinks")).toBe(1);
    expect(calls).toEqual([]);
  });
});

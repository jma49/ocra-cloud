import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallBudget, withCalls } from "../src/calls.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import worker from "../src/index.js";
import { masterKeys } from "../src/keyring.js";
import { advance } from "../src/merge-when-ready/advance.js";
import { saveToken } from "../src/platforms/links.js";
import { platformsOf } from "../src/platforms/registry.js";
import { db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// An armed merge-when-ready intent whose webhook never came (a check that
// finished unheard) is read again by the hourly run, within the run's
// budget of calls; one the budget cut short goes back as it was.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** WORKER_CALLS (src/cron-calls.ts). */
const WORKER_CALLS = 45;
const HEAD = "a".repeat(40);
const HOUR = 60 * 60_000;

type Pull = { state: "OPEN" | "MERGED" | "CLOSED"; mergeState: string };

/** GitHub with every pull request as `pull` says; the merges sent and the calls made. */
function github(pull: Pull) {
  const merges: string[] = [];
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls++;
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repository: {
            autoMergeAllowed: false,
            pullRequest: {
              id: "PR_1",
              headRefOid: HEAD,
              state: pull.state,
              mergeStateStatus: pull.mergeState,
              autoMergeRequest: null,
            },
          },
        },
      });
    }
    if (req.method === "PUT" && url.pathname.endsWith("/merge")) {
      merges.push(url.pathname);
      return Response.json({ merged: true });
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return Response.json({
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      });
    }
    return new Response(null, { status: 404 });
  });
  return { merges, calls: () => calls };
}

async function hourly() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/** An account linked to GitHub with `count` enrolled repositories, an intent armed on each. */
async function armed(count: number, intent: Partial<typeof schema.mergeIntents.$inferInsert> = {}) {
  const me = await signIn(1, "octo");
  const platform = platformsOf(env, ORIGIN).find((p) => p.kind === "github");
  if (!platform) throw new Error("no GitHub");
  await saveToken(scoped(db, me.account.id), env, platform, { access_token: "ghu_token" });
  for (let i = 0; i < count; i++) {
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(`repo-${i}`),
      accountId: me.account.id,
      fullName: `Octo/Repo-${i}`,
      // Read today already: the run's reconciliation leaves it alone.
      reconciledAt: new Date(),
    });
    await db.insert(schema.mergeIntents).values({
      ...rows.mergeIntents(`intent-${i}`),
      accountId: me.account.id,
      fullName: `octo/repo-${i}`,
      head: HEAD,
      reason: "waiting_platform",
      updatedAt: new Date(Date.now() - HOUR - i * 1000),
      ...intent,
    });
  }
  return scoped(db, me.account.id);
}

const eqId = (id: string) => eq(schema.mergeIntents.id, id);
const eqRepo = (id: string) => eq(schema.reviewRepos.id, id);
const intents = () => db.select().from(schema.mergeIntents).orderBy(asc(schema.mergeIntents.id));

describe("the hourly run's sweep of armed intents", () => {
  it("merges one that became ready with no webhook to say so", async () => {
    const data = await armed(1);
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await hourly();
    expect(seen.merges).toEqual(["/repos/octo/repo-0/pulls/1/merge"]);
    expect(await intents()).toMatchObject([{ state: "merged", reason: null, claimedAt: null }]);
    expect((await data.list("auditEvents")).map((e) => e.kind)).toContain(
      "merge_when_ready.merged",
    );
    await hourly();
    expect(seen.merges).toHaveLength(1);
  });

  it("ends one whose pull request closed unheard, and keeps one still waiting armed", async () => {
    await armed(1);
    const pull: Pull = { state: "OPEN", mergeState: "BLOCKED" };
    const seen = github(pull);
    const before = Date.now();
    await hourly();
    const [waiting] = await intents();
    expect(waiting).toMatchObject({ state: "armed", reason: "waiting_platform" });
    expect(waiting?.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    // Read a moment ago: the next run leaves it alone.
    const asked = seen.calls();
    await hourly();
    expect(seen.calls()).toBe(asked);

    await db.update(schema.mergeIntents).set({ updatedAt: new Date(Date.now() - HOUR) });
    pull.state = "CLOSED";
    await hourly();
    expect(await intents()).toMatchObject([{ state: "closed" }]);
    expect(seen.merges).toEqual([]);
  });

  it("leaves alone a native intent, one of a repository no longer enrolled and a live claim", async () => {
    await armed(3);
    const t = schema.mergeIntents;
    await db.update(t).set({ mode: "native" }).where(eqId("intent-0"));
    await db.delete(schema.reviewRepos).where(eqRepo("repo-1"));
    await db.update(t).set({ state: "merging", claimedAt: new Date() }).where(eqId("intent-2"));
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await hourly();
    expect(seen.calls()).toBe(0);
    expect((await intents()).map((i) => i.state)).toEqual(["armed", "armed", "merging"]);
  });

  it("ends a native intent whose close is on record, with no platform call", async () => {
    const data = await armed(3, { mode: "native" });
    const armedAt = new Date(Date.now() - 2 * HOUR);
    await db.update(schema.mergeIntents).set({ createdAt: armedAt });
    const closed = (repo: string, merged: boolean, closedAt: Date) =>
      data.insert("closedPulls", {
        ...rows.closedPulls(`close-${repo}`),
        reviewRepoId: repo,
        merged,
        closedAt,
      });
    await closed("repo-0", true, new Date(Date.now() - HOUR));
    await closed("repo-1", false, new Date(Date.now() - HOUR));
    // Closed before it was armed again (reopened since): still armed.
    await closed("repo-2", true, new Date(Date.now() - 3 * HOUR));
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await hourly();
    expect(seen.calls()).toBe(0);
    expect((await intents()).map((i) => i.state)).toEqual(["merged", "closed", "armed"]);
    const kinds = (await data.list("auditEvents")).map((e) => e.kind).sort();
    expect(kinds).toEqual(["merge_when_ready.closed", "merge_when_ready.merged"]);
  });

  it("takes over a merge whose claim lapsed", async () => {
    await armed(1, { state: "merging", claimedAt: new Date(Date.now() - HOUR) });
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await hourly();
    expect(seen.merges).toHaveLength(1);
    expect(await intents()).toMatchObject([{ state: "merged" }]);
  });

  it("merges each once when two runs overlap", async () => {
    await armed(2);
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await Promise.all([hourly(), hourly()]);
    expect([...seen.merges].sort()).toEqual([
      "/repos/octo/repo-0/pulls/1/merge",
      "/repos/octo/repo-1/pulls/1/merge",
    ]);
  });

  it("stays within the run's calls, the longest untouched first, the rest as they were", async () => {
    await armed(20);
    const was = new Map((await intents()).map((i) => [i.id, i.updatedAt.getTime()]));
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    await hourly();
    expect(seen.calls()).toBeLessThanOrEqual(WORKER_CALLS);
    const after = await intents();
    const merged = after.filter((i) => i.state === "merged");
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.length).toBeLessThan(20);
    expect(seen.merges).toHaveLength(merged.length);
    // intent-19 was touched longest ago.
    const oldest = [...after].sort((a, b) => (was.get(a.id) ?? 0) - (was.get(b.id) ?? 0));
    expect(oldest.slice(0, merged.length).every((i) => i.state === "merged")).toBe(true);
    for (const i of after.filter((x) => x.state !== "merged")) {
      expect(i, i.id).toMatchObject({
        state: "armed",
        reason: "waiting_platform",
        claimedAt: null,
      });
      expect(i.updatedAt.getTime(), i.id).toBe(was.get(i.id));
    }
    for (let run = 0; run < 8; run++) await hourly();
    expect((await intents()).every((i) => i.state === "merged")).toBe(true);
    expect(new Set(seen.merges).size).toBe(20);
    expect(seen.merges).toHaveLength(20);
  });

  it("gives back, as it was, an intent the budget cut short at any call", async () => {
    const data = await armed(1);
    const platform = platformsOf(env, ORIGIN).find((p) => p.kind === "github");
    const [intent] = await intents();
    const repo = await data.get("reviewRepos", "repo-0");
    if (!platform || !intent || !repo) throw new Error("not set up");
    const out = { keys: masterKeys(env), mailer: undefined, linkSecret: "s", origin: ORIGIN };
    const runner = { db, env, platforms: [platform], out };
    const seen = github({ state: "OPEN", mergeState: "CLEAN" });
    // The pull request, the repository's methods, the merge: cut before each in turn.
    for (const calls of [0, 1, 2]) {
      await withCalls(new CallBudget(calls), () =>
        advance({ runner, data, platform, repo }, intent),
      );
      expect(await intents(), `${calls} calls`).toEqual([intent]);
    }
    expect(seen.merges).toEqual([]);
    await withCalls(new CallBudget(3), () => advance({ runner, data, platform, repo }, intent));
    expect(await intents()).toMatchObject([{ state: "merged" }]);
  });
});

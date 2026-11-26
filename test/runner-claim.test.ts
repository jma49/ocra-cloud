import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { remoteReviews } from "../src/auto-review/remote.js";
import { resetRunnerThrottle } from "../src/auto-review/runner-api.js";
import { CLAIM_KINDS, pendingWork, recoverLapsedJobs } from "../src/db/job-recovery.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import worker from "../src/index.js";
import { platformsOf } from "../src/platforms/registry.js";
import { db, ORIGIN, request, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

const RUNNER = "runner-token-of-at-least-32-characters";
const gitlabOnly = { GITLAB_BOT_TOKEN: "glpat-bot", RUNNER_TOKEN: RUNNER };

const app = createApp({
  openDb: (bindings: typeof env) => drizzle(bindings.DB),
  clientAddress: () => "203.0.113.9",
  ...remoteReviews(gitlabOnly),
});

function limiter(allowed: number) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: keys.length <= allowed };
      },
    },
  };
}

async function claim(
  json: Record<string, unknown>,
  overrides: Partial<typeof env> = {},
): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/runner/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${RUNNER}` },
      json,
    }),
    { ...env, ...overrides },
    ctx,
  );
  const body = (await res.json()) as Record<string, unknown>;
  await waitOnExecutionContext(ctx);
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
}

const lab = platformsOf(env, ORIGIN).find((p) => p.kind === "gitlab");
const hello = {
  name: "mini",
  version: "0.25.0",
  graphs: true,
  restack: true,
  answers: ["fix", "mend"],
};

let accountId = "";
let repoId = "";

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.reviewRunners);
  accountId = (await signIn(1, "user-1")).account.id;
  repoId =
    (await scoped(db, accountId).autoReview.enroll(
      { platform: "gitlab", host: lab?.host ?? "", platformRepoId: "11", fullName: "acme/api" },
      100,
    )) ?? "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pendingWork", () => {
  it("detects due queued jobs and lapsed running jobs in one probe across every queue", async () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const empty = await pendingWork(db, CLAIM_KINDS, now, true);
    expect([...empty.queued]).toEqual([]);
    expect([...empty.lapsed]).toEqual([]);

    // Future notBefore is not due; live running lease is not lapsed.
    await db.insert(schema.reviewJobs).values({
      ...rows.reviewJobs("future-review"),
      accountId,
      reviewRepoId: repoId,
      number: 1,
      state: "queued",
      notBefore: new Date(now.getTime() + 60_000),
    });
    await db.insert(schema.replyJobs).values({
      ...rows.replyJobs("live-reply"),
      accountId,
      reviewRepoId: repoId,
      number: 2,
      state: "running",
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    const stillEmpty = await pendingWork(db, CLAIM_KINDS, now, true);
    expect([...stillEmpty.queued]).toEqual([]);
    expect([...stillEmpty.lapsed]).toEqual([]);

    // Due queued job and lapsed running job are both detected.
    await db.insert(schema.learnJobs).values({
      ...rows.learnJobs("due-learn"),
      accountId,
      reviewRepoId: repoId,
      number: 3,
      state: "queued",
      notBefore: now,
    });
    await db.insert(schema.mendJobs).values({
      ...rows.mendJobs("lapsed-mend"),
      accountId,
      reviewRepoId: repoId,
      number: 4,
      state: "running",
      leaseUntil: new Date(now.getTime() - 1_000),
    });
    const withoutLapsed = await pendingWork(db, CLAIM_KINDS, now, false);
    expect([...withoutLapsed.queued]).toEqual(["learn"]);
    expect([...withoutLapsed.lapsed]).toEqual([]);

    const withLapsed = await pendingWork(db, CLAIM_KINDS, now, true);
    expect([...withLapsed.queued]).toEqual(["learn"]);
    expect([...withLapsed.lapsed]).toEqual(["mend"]);
  });
});

describe("runner claim throttling and limits", () => {
  it("throttles runnerSeen writes in memory and writes again on version change or after 60s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
    resetRunnerThrottle();

    expect(await claim(hello)).toMatchObject({ status: 200, body: { assignment: null } });
    const first = await db.select().from(schema.reviewRunners);
    expect(first).toHaveLength(1);
    const seenAt = first[0]?.lastSeenAt.getTime();

    // Delete the row underneath to prove a warm poll within 60s skips the DB write.
    await db.delete(schema.reviewRunners);
    vi.advanceTimersByTime(10_000);
    expect(await claim(hello)).toMatchObject({ status: 200, body: { assignment: null } });
    expect(await db.select().from(schema.reviewRunners)).toEqual([]);

    // A version bump writes immediately.
    expect(await claim({ ...hello, version: "0.26.0" })).toMatchObject({
      status: 200,
      body: { assignment: null },
    });
    const upgraded = await db.select().from(schema.reviewRunners);
    expect(upgraded).toMatchObject([{ name: "mini", version: "0.26.0" }]);
    const upgradedAt = upgraded[0]?.lastSeenAt.getTime() ?? 0;
    expect(upgradedAt).toBeGreaterThan(seenAt ?? 0);

    // After 60s, the same version writes again.
    vi.advanceTimersByTime(60_000);
    expect(await claim({ ...hello, version: "0.26.0" })).toMatchObject({
      status: 200,
      body: { assignment: null },
    });
    const refreshed = await db.select().from(schema.reviewRunners);
    expect(refreshed[0]?.lastSeenAt.getTime()).toBe(upgradedAt + 60_000);
  });

  it("refuses a runner past its per-minute rate limit without touching the database", async () => {
    const rate = limiter(0);
    const res = await claim(hello, { ACCOUNT_CALLS: rate.binding });
    expect(res).toMatchObject({
      status: 429,
      retryAfter: "60",
      body: { error: "slow_down" },
    });
    expect(rate.keys).toEqual(["runner:mini"]);
    expect(await db.select().from(schema.reviewRunners)).toEqual([]);
  });

  it("recovers lapsed leases on poll and in the hourly cron", async () => {
    await db.insert(schema.reviewJobs).values({
      ...rows.reviewJobs("spent-job"),
      accountId,
      reviewRepoId: repoId,
      number: 9,
      state: "running",
      attempts: 3,
      leaseUntil: new Date(Date.now() - 60_000),
    });
    expect(await claim(hello)).toMatchObject({ status: 200, body: { assignment: null } });
    const [spent] = await db
      .select()
      .from(schema.reviewJobs)
      .where(eq(schema.reviewJobs.id, "spent-job"));
    expect(spent).toMatchObject({ state: "failed", error: "lease_lapsed" });

    // Hourly cron also recovers lapsed leases without a runner polling.
    await db.insert(schema.replyJobs).values({
      ...rows.replyJobs("lapsed-reply"),
      accountId,
      reviewRepoId: repoId,
      number: 10,
      state: "running",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000),
    });
    await recoverLapsedJobs(db);
    const [requeued] = await db
      .select()
      .from(schema.replyJobs)
      .where(eq(schema.replyJobs.id, "lapsed-reply"));
    expect(requeued).toMatchObject({ state: "queued", leaseUntil: null });

    await db.insert(schema.generateJobs).values({
      ...rows.generateJobs("lapsed-gen"),
      accountId,
      reviewRepoId: repoId,
      number: 11,
      state: "running",
      attempts: 3,
      leaseUntil: new Date(Date.now() - 60_000),
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const [failedGen] = await db
      .select()
      .from(schema.generateJobs)
      .where(eq(schema.generateJobs.id, "lapsed-gen"));
    expect(failedGen).toMatchObject({ state: "failed", error: "lease_lapsed" });
  });
});

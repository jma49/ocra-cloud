import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { claimGenerate } from "../src/db/generate-jobs.js";
import { claimLearn } from "../src/db/learn-jobs.js";
import { claimReply } from "../src/db/reply-jobs.js";
import { claimJob } from "../src/db/review-jobs.js";
import * as schema from "../src/db/schema.js";
import worker from "../src/index.js";
import { db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// A job of auto review that a run or a runner left behind: a run that died
// is queued again only while the job has runs left, and a job nothing
// claims is given up after a week, both by the claims and the daily run.

let accountId = "";
beforeEach(async () => {
  await resetDb();
  const me = await signIn(1, "octo");
  accountId = me.account.id;
  await db
    .insert(schema.reviewRepos)
    .values({ ...rows.reviewRepos("review-repo-of-a"), accountId });
});

const CALLS = 1000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const TABLES = {
  review: schema.reviewJobs,
  reply: schema.replyJobs,
  generate: schema.generateJobs,
  learn: schema.learnJobs,
} as const;
type Kind = keyof typeof TABLES;

let made = 0;

async function job(kind: Kind, id: string, fields: Record<string, unknown>) {
  await db
    .insert(TABLES[kind])
    .values({ ...rows[`${kind}Jobs`](id), number: ++made, accountId, ...fields } as never);
}

const states = (kind: Kind) =>
  db
    .select({ id: TABLES[kind].id, state: TABLES[kind].state, error: TABLES[kind].error })
    .from(TABLES[kind])
    .orderBy(asc(TABLES[kind].id));

const claims = {
  review: (now: Date) => claimJob(db, now, MINUTE, CALLS),
  reply: (now: Date) => claimReply(db, now, MINUTE, CALLS),
  generate: (now: Date) => claimGenerate(db, now, MINUTE, CALLS),
  learn: (now: Date) => claimLearn(db, now, MINUTE, CALLS),
};

async function daily() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "17 4 * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const lapsed = () => new Date(Date.now() - MINUTE);

describe.each(Object.keys(TABLES) as Kind[])("a %s job left behind", (kind) => {
  it("is failed, not claimed again, when its lapsed run was its third", async () => {
    await job(kind, "j1", { state: "running", attempts: 3, leaseUntil: lapsed() });
    expect(await claims[kind](new Date())).toBeUndefined();
    expect(await states(kind)).toEqual([{ id: "j1", state: "failed", error: "lease_lapsed" }]);
  });

  it("is queued again and claimed while it has runs left", async () => {
    await job(kind, "j1", { state: "running", attempts: 1, leaseUntil: lapsed() });
    expect(await claims[kind](new Date())).toMatchObject({ id: "j1", attempts: 2 });
  });

  it("is recovered by the daily run, with no claim", async () => {
    const old = new Date(Date.now() - 8 * DAY);
    await job(kind, "a-lapsed", { state: "running", attempts: 1, leaseUntil: lapsed() });
    await job(kind, "b-spent", { state: "running", attempts: 3, leaseUntil: lapsed() });
    await job(kind, "c-live", {
      state: "running",
      attempts: 3,
      leaseUntil: new Date(Date.now() + MINUTE),
    });
    await job(kind, "d-stale", { state: "queued", createdAt: old });
    await job(kind, "e-recent", { state: "queued", createdAt: new Date(Date.now() - DAY) });
    await job(kind, "f-done", { state: "done", createdAt: old, finishedAt: old });
    await daily();
    expect(await states(kind)).toEqual([
      { id: "a-lapsed", state: "queued", error: null },
      { id: "b-spent", state: "failed", error: "lease_lapsed" },
      { id: "c-live", state: "running", error: null },
      { id: "d-stale", state: "failed", error: "never_started" },
      { id: "e-recent", state: "queued", error: null },
      { id: "f-done", state: "done", error: null },
    ]);
  });
});

import { and, eq, gte, lt } from "drizzle-orm";
import { DAY } from "../time.js";
import type { Db } from "./client.js";
import { generateJobs, replyJobs, reviewJobs } from "./schema.js";

// The jobs of auto review a run or a runner left behind: a run that died
// keeps its job running until its lease lapses, and a job nothing claims
// (no runner, a repository whose account never gets a call back) stays
// queued. Each is moved by a compare-and-set on its state, so a run that
// finishes meanwhile, or a claim, wins or loses it whole.

/** A job's runs at most: a run that dies counts as one, so a job that kills its runner ends. */
export const JOB_ATTEMPTS = 3;
/** A job no run took for this long is given up: whatever it answered is long stale. */
const QUEUED_DAYS = 7;

/** Why a job was given up here, as its `error` says. */
const LEASE_LAPSED = "lease_lapsed";
const NEVER_STARTED = "never_started";

type JobTable = typeof reviewJobs | typeof replyJobs | typeof generateJobs;

/**
 * Queues again the job's runs whose lease lapsed while it has attempts
 * left, and fails the others with LEASE_LAPSED; the claim queries call it
 * before they claim.
 */
export async function recoverLapsed(db: Db, j: JobTable, now: Date): Promise<void> {
  const lapsed = and(eq(j.state, "running"), lt(j.leaseUntil, now));
  await db
    .update(j)
    .set({ state: "failed", leaseUntil: null, error: LEASE_LAPSED, finishedAt: now })
    .where(and(lapsed, gte(j.attempts, JOB_ATTEMPTS)));
  await db
    .update(j)
    .set({ state: "queued", leaseUntil: null })
    .where(and(lapsed, lt(j.attempts, JOB_ATTEMPTS)));
}

/**
 * Every table's lapsed runs, as above, and the jobs queued for more than
 * QUEUED_DAYS failed with NEVER_STARTED. Runs daily with retention; it
 * calls nothing outside the database.
 */
export async function recoverJobs(db: Db, now = new Date()): Promise<void> {
  const stale = new Date(now.getTime() - QUEUED_DAYS * DAY);
  for (const j of [reviewJobs, replyJobs, generateJobs]) {
    await recoverLapsed(db, j, now);
    await db
      .update(j)
      .set({ state: "failed", error: NEVER_STARTED, finishedAt: now })
      .where(and(eq(j.state, "queued"), lt(j.createdAt, stale)));
  }
}

import { and, desc, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { changedRows, type Db, first } from "./client.js";
import { mayStart } from "./counters.js";
import { recoverLapsed } from "./job-recovery.js";
import { repoRuns } from "./repo-lifecycle.js";
import { learnJobs } from "./schema.js";

// The pull requests whose declined findings wait to be drafted into
// learnings (reached through scoped() for an account's own, claimJob-style
// from the queue): one row per pull request, by the unique index. Each
// thread a person answers or resolves queues it again in one statement; one
// that arrives during its run is kept as `again`, which the run's end turns
// into the next run, so no answer is read by nobody.

/** Jobs listed for one repository. */
const MAX_LISTED = 10;

const j = learnJobs;

export function accountLearnJobs(db: Db, accountId: string) {
  const own = eq(j.accountId, accountId);
  const claimedBy = (id: string, attempts: number) =>
    and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts));
  /** The run's end when a thread was answered during it: queued once more, at once. */
  const runAgain = async (id: string, attempts: number) => {
    const result = await db
      .update(j)
      .set({ state: "queued", again: false, attempts: 0, notBefore: null, leaseUntil: null })
      .where(and(claimedBy(id, attempts), eq(j.again, true)));
    return changedRows(result) > 0;
  };
  return {
    /** Queues the pull request to be read at `at`; one whose run is under way runs again after it. */
    async queue(reviewRepoId: string, number: number, at: Date): Promise<void> {
      const idle = (column: SQLiteColumn, value: SQL): SQL =>
        sql`CASE WHEN ${j.state} = 'running' THEN ${column} ELSE ${value} END`;
      await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number, notBefore: at })
        .onConflictDoUpdate({
          target: [j.reviewRepoId, j.number],
          set: {
            again: sql`CASE WHEN ${j.state} = 'running' THEN 1 ELSE 0 END`,
            state: idle(j.state, sql`'queued'`),
            attempts: idle(j.attempts, sql`0`),
            notBefore: idle(j.notBefore, sql`${at.getTime()}`),
            error: idle(j.error, sql`NULL`),
            finishedAt: idle(j.finishedAt, sql`NULL`),
          },
        });
    },
    /** The repository's jobs that wait or run, and those that ended since a time, newest first. */
    recent(reviewRepoId: string, since: Date) {
      return db
        .select()
        .from(j)
        .where(
          and(
            own,
            eq(j.reviewRepoId, reviewRepoId),
            or(inArray(j.state, ["queued", "running"]), gt(j.finishedAt, since)),
          ),
        )
        .orderBy(desc(j.createdAt))
        .limit(MAX_LISTED);
    },
    /** Records the run's end, only while it is still the run that claimed it. */
    async finish(id: string, attempts: number, now: Date) {
      if (await runAgain(id, attempts)) return;
      await db
        .update(j)
        .set({ state: "done", error: null, leaseUntil: null, finishedAt: now })
        .where(claimedBy(id, attempts));
    },
    /** Queues it again at retryAt, or gives it up with the error when retryAt is null. */
    async release(id: string, attempts: number, error: string, retryAt: Date | null, now: Date) {
      if (!retryAt && (await runAgain(id, attempts))) return;
      await db
        .update(j)
        .set(
          retryAt
            ? { state: "queued", notBefore: retryAt, leaseUntil: null, error }
            : { state: "failed", leaseUntil: null, error, finishedAt: now },
        )
        .where(claimedBy(id, attempts));
    },
  };
}

export type ClaimedLearn = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  attempts: number;
  leaseUntil: Date;
};

/** Claims the pull request waiting longest, or undefined when none is due. */
export async function claimLearn(
  db: Db,
  now: Date,
  leaseMs: number,
  dailyCalls: number,
  recover = true,
): Promise<ClaimedLearn | undefined> {
  // A run that died keeps its row running until its lease lapses: queued again here, or failed
  // once it has used its attempts.
  if (recover) await recoverLapsed(db, j, now);
  const due = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        eq(j.state, "queued"),
        or(isNull(j.notBefore), lte(j.notBefore, now)),
        mayStart(j.accountId, dailyCalls, now),
        repoRuns(j.reviewRepoId),
      ),
    )
    .orderBy(j.createdAt)
    .limit(1)
    .then(first);
  if (!due) return undefined;
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const [claimed] = await db
    .update(j)
    .set({ state: "running", leaseUntil, attempts: sql`${j.attempts} + 1` })
    .where(and(eq(j.id, due.id), eq(j.state, "queued")))
    .returning({
      id: j.id,
      accountId: j.accountId,
      reviewRepoId: j.reviewRepoId,
      number: j.number,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

import type {
  FixFailureCause,
  MendItemOutcome,
  MendItemReason,
  MendOutcome,
  MendState,
} from "@open-cr-agent/cloud-contract";
import { and, asc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { changedRows, type Db, first } from "./client.js";
import { countOne, mayStart, uncountOne } from "./counters.js";
import { recoverLapsed } from "./job-recovery.js";
import { repoRuns } from "./repo-lifecycle.js";
import { findings, mendItems, mendJobs } from "./schema.js";

// The fix loops of an account's pull requests (ADR-0078; reached through
// scoped() for an account's own, claimJob-style from the queue): one row
// per pull request, by the unique index, so one round runs on it at a time,
// and one item per finding asked for. A request queues the loop in one
// statement; one that arrives during a round is kept as `again`, which the
// round's end turns into the next, as a finding that still waits does.

/** Items listed for one pull request: a review holds few findings a person asks fixes for. */
const MAX_LISTED = 200;

/** Outcomes a finding may be asked for again after: no edit of the round was written for it. */
const RETRIABLE: MendItemOutcome[] = ["rejected", "deferred"];

const j = mendJobs;
const i = mendItems;

/** What a round says of one finding it was given. */
type RoundItem = {
  fingerprint: string;
  outcome: MendItemOutcome;
  reason: MendItemReason | null;
  cause: FixFailureCause | null;
};

/** How a round ended, as `ocra mend --json` printed it. */
export type RoundEnd = {
  outcome: MendOutcome;
  commitSha: string | null;
  loop: MendState;
  items: readonly RoundItem[];
};

export function accountMendJobs(db: Db, accountId: string) {
  const own = eq(j.accountId, accountId);
  const ownItem = eq(i.accountId, accountId);
  const claimedBy = (id: string, attempts: number) =>
    and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts));
  const waiting = (jobId: string) => and(ownItem, eq(i.jobId, jobId), isNull(i.outcome));

  /** Queues the pull request's next round at `at`; one whose round is under way runs again after it. */
  const queue = async (reviewRepoId: string, number: number, at: Date) => {
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
        setWhere: own,
      });
  };

  const jobOf = (reviewRepoId: string, number: number) =>
    db
      .select()
      .from(j)
      .where(and(own, eq(j.reviewRepoId, reviewRepoId), eq(j.number, number)))
      .limit(1)
      .then(first);

  return {
    /**
     * Asks the pull request's loop to fix these findings and queues its
     * next round at `at`, each counted against the account's `cap` a day; a
     * finding that waits already, or that a round fixed or closed, is left
     * as it is and not counted. How many now wait that did not, and whether
     * the day's requests ran out before all were asked.
     */
    async request(
      pull: { reviewRepoId: string; number: number },
      wanted: readonly { findingId: string; fingerprint: string }[],
      cap: number,
      at: Date,
      now: Date,
    ): Promise<{ queued: number; limited: boolean }> {
      const counted: (typeof wanted)[number][] = [];
      for (const finding of wanted) {
        if (!(await countOne(db, accountId, "fix_requests", cap, now))) break;
        counted.push(finding);
      }
      const limited = counted.length < wanted.length;
      if (counted.length === 0) return { queued: 0, limited };
      await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, ...pull, state: "done", finishedAt: now })
        .onConflictDoNothing({ target: [j.reviewRepoId, j.number] });
      const job = await jobOf(pull.reviewRepoId, pull.number);
      if (!job) return { queued: 0, limited };
      const asked = await db
        .insert(i)
        .values(counted.map((f) => ({ id: crypto.randomUUID(), accountId, jobId: job.id, ...f })))
        .onConflictDoUpdate({
          target: [i.accountId, i.findingId],
          set: {
            outcome: null,
            reason: null,
            cause: null,
            commitSha: null,
            finishedAt: null,
            createdAt: now,
          },
          setWhere: inArray(i.outcome, RETRIABLE),
        })
        .returning({ id: i.id });
      for (let n = asked.length; n < counted.length; n++) {
        await uncountOne(db, accountId, "fix_requests", now);
      }
      // After the items, so a round that ends meanwhile either sees them or is queued again here.
      if (asked.length > 0) await queue(pull.reviewRepoId, pull.number, at);
      return { queued: asked.length, limited };
    },
    /** The pull request's loop and the findings asked of it, oldest first. */
    async forPull(reviewRepoId: string, number: number) {
      const job = await jobOf(reviewRepoId, number);
      if (!job) return undefined;
      const items = await db
        .select()
        .from(i)
        .where(and(ownItem, eq(i.jobId, job.id)))
        .orderBy(asc(i.createdAt), asc(i.id))
        .limit(MAX_LISTED);
      return { job, items };
    },
    /** The findings that wait for the loop's next round, the first asked first, at most `limit`. */
    waitingFindings(jobId: string, limit: number) {
      return db
        .select({ finding: findings })
        .from(i)
        .innerJoin(findings, and(eq(findings.id, i.findingId), eq(findings.accountId, accountId)))
        .where(waiting(jobId))
        .orderBy(asc(i.createdAt), asc(i.id))
        .limit(limit)
        .then((rows) => rows.map((r) => r.finding));
    },
    /**
     * Records how the round ended, only while it is still the run that
     * claimed it, and what became of each finding it was given: one the
     * round put off while it committed others keeps waiting, and so the
     * loop is queued again, as it is for a request made during the round.
     * The ids of the findings its commit fixed; undefined when the round
     * was not this run's to record.
     */
    async finish(
      id: string,
      attempts: number,
      round: RoundEnd,
      now: Date,
    ): Promise<string[] | undefined> {
      const ended = await db
        .update(j)
        .set({
          state: "done",
          outcome: round.outcome,
          commitSha: round.commitSha,
          loop: round.loop,
          error: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(claimedBy(id, attempts));
      if (changedRows(ended) === 0) return undefined;
      const fixed: string[] = [];
      for (const item of round.items) {
        // Put off beside a commit: the next round, on the new head, takes it.
        if (item.outcome === "deferred" && round.outcome === "committed") continue;
        const written = await db
          .update(i)
          .set({
            outcome: item.outcome,
            reason: item.reason,
            cause: item.cause,
            commitSha: item.outcome === "fixed" ? round.commitSha : null,
            finishedAt: now,
          })
          .where(and(waiting(id), eq(i.fingerprint, item.fingerprint)))
          .returning({ findingId: i.findingId });
        if (item.outcome === "fixed") fixed.push(...written.map((w) => w.findingId));
      }
      await db
        .update(j)
        .set({ state: "queued", again: false, attempts: 0, notBefore: null, finishedAt: null })
        .where(
          and(
            own,
            eq(j.id, id),
            eq(j.state, "done"),
            or(
              eq(j.again, true),
              sql`EXISTS (SELECT 1 FROM ${i} WHERE ${i.jobId} = ${id} AND ${i.outcome} IS NULL)`,
            ),
          ),
        );
      return fixed;
    },
    /**
     * Ends a round that ran nothing (the level changed, nothing waited)
     * with `note`, only while it is still the run that claimed it.
     */
    async skip(id: string, attempts: number, note: string, now: Date) {
      await db
        .update(j)
        .set({ state: "done", again: false, error: note, leaseUntil: null, finishedAt: now })
        .where(claimedBy(id, attempts));
    },
    /** Queues it again at retryAt, or gives it up with the error when retryAt is null. */
    async release(id: string, attempts: number, error: string, retryAt: Date | null, now: Date) {
      await db
        .update(j)
        .set(
          retryAt
            ? { state: "queued", notBefore: retryAt, leaseUntil: null, error }
            : { state: "failed", again: false, leaseUntil: null, error, finishedAt: now },
        )
        .where(claimedBy(id, attempts));
    },
  };
}

export type ClaimedMend = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  attempts: number;
  leaseUntil: Date;
};

/** Claims the loop waiting longest for its round, or undefined when none is due. */
export async function claimMend(
  db: Db,
  now: Date,
  leaseMs: number,
  dailyCalls: number,
): Promise<ClaimedMend | undefined> {
  await recoverLapsed(db, j, now);
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

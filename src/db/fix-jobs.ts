import type { FixOutcome, FixReason } from "@open-cr-agent/cloud-contract";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { countOne, mayStart, uncountOne } from "./counters.js";
import { recoverLapsed } from "./job-recovery.js";
import { repoRuns } from "./repo-lifecycle.js";
import { findings, fixJobs } from "./schema.js";

// Fixes asked of `ocra fix` for stored findings (reached through scoped()
// for an account's own, claimJob-style from the queue): one per finding and
// head by the unique index, each claimed by one runner by a compare-and-set.

/** Requests listed for one pull request: one per finding at most a review holds. */
const MAX_LISTED = 200;

/** A proposed fix, as the finding's fix columns hold it. */
type ProposedFix = { startLine: number; endLine: number; replacement: string };

export function accountFixJobs(db: Db, accountId: string) {
  const j = fixJobs;
  const own = eq(j.accountId, accountId);
  return {
    /**
     * Queues a fix of the finding at head, or queues again one that failed,
     * counted against the account's `cap` a day; a request already queued,
     * running or answered is left as it is and not counted. Whether it
     * queued; "limited" when the day's requests are used up.
     */
    async request(
      job: { reviewRepoId: string; number: number; findingId: string; head: string },
      cap: number,
      now: Date,
    ): Promise<boolean | "limited"> {
      if (!(await countOne(db, accountId, "fix_requests", cap, now))) return "limited";
      const queued = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, ...job })
        .onConflictDoUpdate({
          target: [j.accountId, j.findingId, j.head],
          set: {
            state: "queued",
            attempts: 0,
            notBefore: null,
            leaseUntil: null,
            error: null,
            outcome: null,
            reason: null,
            finishedAt: null,
          },
          setWhere: eq(j.state, "failed"),
        })
        .returning({ id: j.id });
      if (queued.length > 0) return true;
      await uncountOne(db, accountId, "fix_requests", now);
      return false;
    },
    /** The finding's request at head, if any. */
    forFinding(findingId: string, head: string) {
      return db
        .select()
        .from(j)
        .where(and(own, eq(j.findingId, findingId), eq(j.head, head)))
        .limit(1)
        .then(first);
    },
    /** The pull request's requests, newest first. */
    forPull(reviewRepoId: string, number: number) {
      return db
        .select()
        .from(j)
        .where(and(own, eq(j.reviewRepoId, reviewRepoId), eq(j.number, number)))
        .orderBy(desc(j.createdAt))
        .limit(MAX_LISTED);
    },
    /**
     * Records what `ocra fix` answered, only while it is still the run that
     * claimed it, and a proposed fix in the finding's fix columns unless it
     * got one meanwhile. Whether it was this run's to record.
     */
    async finish(
      id: string,
      attempts: number,
      answer: { outcome: FixOutcome; reason: FixReason | null; fix: ProposedFix | null },
      now: Date,
    ): Promise<boolean> {
      const [done] = await db
        .update(j)
        .set({
          state: "done",
          outcome: answer.outcome,
          reason: answer.reason,
          error: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts)))
        .returning({ findingId: j.findingId });
      if (!done) return false;
      const fix = answer.fix;
      if (fix) {
        const f = findings;
        await db
          .update(f)
          .set({
            fixStartLine: fix.startLine,
            fixEndLine: fix.endLine,
            fixReplacement: fix.replacement,
          })
          .where(
            and(eq(f.accountId, accountId), eq(f.id, done.findingId), isNull(f.fixReplacement)),
          );
      }
      return true;
    },
    /** Queues it again at retryAt, or gives it up with the error when retryAt is null. */
    async release(id: string, attempts: number, error: string, retryAt: Date | null, now: Date) {
      const result = await db
        .update(j)
        .set(
          retryAt
            ? { state: "queued", notBefore: retryAt, leaseUntil: null, error }
            : { state: "failed", leaseUntil: null, error, finishedAt: now },
        )
        .where(and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts)));
      return changedRows(result) > 0;
    },
  };
}

export type ClaimedFix = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  findingId: string;
  head: string;
  attempts: number;
  leaseUntil: Date;
};

/** Claims the request waiting longest, or undefined when none is due. */
export async function claimFix(
  db: Db,
  now: Date,
  leaseMs: number,
  dailyCalls: number,
): Promise<ClaimedFix | undefined> {
  const j = fixJobs;
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
      findingId: j.findingId,
      head: j.head,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

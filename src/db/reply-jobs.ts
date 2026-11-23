import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { mayStart } from "./counters.js";
import { recoverLapsed } from "./job-recovery.js";
import { repoRuns } from "./repo-lifecycle.js";
import { replyJobs } from "./schema.js";

// Answers to @ocra comments (reached through scoped() for an account's own,
// claimJob-style from the queue): one per comment, by the unique index, and
// each claimed by one runner, by a compare-and-set on its state.

export function accountReplyJobs(db: Db, accountId: string) {
  const j = replyJobs;
  const own = eq(j.accountId, accountId);
  return {
    /** Queues an answer to the comment unless it has one; whether it queued. */
    async queue(reviewRepoId: string, number: number, commentId: string, inline: boolean) {
      const result = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number, commentId, inline })
        .onConflictDoNothing({ target: [j.reviewRepoId, j.commentId] });
      return changedRows(result) > 0;
    },
    /** Records the answer, only while it is still the run that claimed it. */
    async finish(id: string, attempts: number, now: Date) {
      await db
        .update(j)
        .set({ state: "done", error: null, leaseUntil: null, finishedAt: now })
        .where(and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts)));
    },
    /** Queues it again at retryAt, or gives it up with the error when retryAt is null. */
    async release(id: string, attempts: number, error: string, retryAt: Date | null, now: Date) {
      await db
        .update(j)
        .set(
          retryAt
            ? { state: "queued", notBefore: retryAt, leaseUntil: null, error }
            : { state: "failed", leaseUntil: null, error, finishedAt: now },
        )
        .where(and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts)));
    },
  };
}

export type ClaimedReply = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  commentId: string;
  inline: boolean;
  attempts: number;
  leaseUntil: Date;
};

/** Claims the answer waiting longest, or undefined when none is due. */
export async function claimReply(
  db: Db,
  now: Date,
  leaseMs: number,
  dailyCalls: number,
): Promise<ClaimedReply | undefined> {
  const j = replyJobs;
  // A run that died keeps its row running until its lease lapses: queued again here, or failed
  // once it has used its attempts.
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
      commentId: j.commentId,
      inline: j.inline,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

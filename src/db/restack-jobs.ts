import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { RestackOutcome } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { recoverLapsed } from "./job-recovery.js";
import { repoRuns } from "./repo-lifecycle.js";
import { restackJobs } from "./schema.js";

// Stacked pull requests the bot rebases after the one below merged
// (src/stack-merge/restack.ts), reached through scoped() for an account's
// own and claimed from the queue by a compare-and-set, as the other jobs.

/** Restacks a repository's history lists. */
const MAX_LISTED = 50;

export type RestackStart = {
  reviewRepoId: string;
  number: number;
  parentMerge: string;
  parent: number;
  branch: string;
  head: string;
  ontoBranch: string;
  ontoCommit: string | null;
  upstream: string;
  /** Who asked for it by hand; left out when a merge queued it. */
  askedBy?: string;
};

export function accountRestackJobs(db: Db, accountId: string) {
  const j = restackJobs;
  const own = eq(j.accountId, accountId);
  const ended = (id: string, attempts: number) =>
    and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts));
  return {
    /** Queues the restack unless this merge already queued one of the pull request; whether it queued. */
    async queue(start: RestackStart) {
      const result = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, ...start })
        .onConflictDoNothing({ target: [j.reviewRepoId, j.number, j.parentMerge] });
      return changedRows(result) > 0;
    },
    /**
     * Queues a restack someone asked for, or queues again the one these
     * heads already had once it ended; whether it queued.
     */
    async ask(start: RestackStart & { askedBy: string }) {
      const result = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, ...start })
        .onConflictDoUpdate({
          target: [j.reviewRepoId, j.number, j.parentMerge],
          set: {
            state: "queued",
            outcome: null,
            restackedTo: null,
            attempts: 0,
            notBefore: null,
            leaseUntil: null,
            error: null,
            finishedAt: null,
            askedBy: start.askedBy,
          },
          setWhere: sql`${j.state} in ('done', 'failed')`,
        });
      return changedRows(result) > 0;
    },
    /** The newest restack of the pull request, if any. */
    newestOf(reviewRepoId: string, number: number) {
      return db
        .select()
        .from(j)
        .where(and(own, eq(j.reviewRepoId, reviewRepoId), eq(j.number, number)))
        .orderBy(desc(j.createdAt), desc(j.id))
        .limit(1)
        .then(first);
    },
    /** The repository's restacks, newest first. */
    forRepo(reviewRepoId: string) {
      return db
        .select()
        .from(j)
        .where(and(own, eq(j.reviewRepoId, reviewRepoId)))
        .orderBy(desc(j.createdAt), desc(j.id))
        .limit(MAX_LISTED);
    },
    /** Records how it ended, only while it is still the run that claimed it; whether it was. */
    async finish(
      id: string,
      attempts: number,
      outcome: RestackOutcome,
      restackedTo: string | null,
      reason: string | null,
      now: Date,
    ) {
      const result = await db
        .update(j)
        .set({
          state: "done",
          outcome,
          restackedTo,
          error: reason,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(ended(id, attempts));
      return changedRows(result) > 0;
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
        .where(ended(id, attempts));
    },
  };
}

export type ClaimedRestack = Omit<
  typeof restackJobs.$inferSelect,
  "state" | "outcome" | "restackedTo" | "notBefore" | "error" | "finishedAt" | "createdAt"
> & { leaseUntil: Date };

/** Claims the restack waiting longest, or undefined when none is due. */
export async function claimRestack(
  db: Db,
  now: Date,
  leaseMs: number,
  recover = true,
): Promise<ClaimedRestack | undefined> {
  const j = restackJobs;
  if (recover) await recoverLapsed(db, j, now);
  // A restack makes no model call: the daily limit on an account's calls does not hold it.
  const due = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        eq(j.state, "queued"),
        or(isNull(j.notBefore), lte(j.notBefore, now)),
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
      parentMerge: j.parentMerge,
      parent: j.parent,
      branch: j.branch,
      head: j.head,
      ontoBranch: j.ontoBranch,
      ontoCommit: j.ontoCommit,
      upstream: j.upstream,
      askedBy: j.askedBy,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

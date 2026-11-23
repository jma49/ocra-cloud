import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { GenerateKind } from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { callsLeft } from "./counters.js";
import { generateJobs } from "./schema.js";

// Tests or docstrings asked for on a pull request (reached through scoped()
// for an account's own, claimJob-style from the queue): one per head and
// kind, by the unique index, each claimed by one runner by a compare-and-set.

/** Requests listed for one pull request: the newest few are what its page shows. */
const MAX_LISTED = 20;

export function accountGenerateJobs(db: Db, accountId: string) {
  const j = generateJobs;
  const own = eq(j.accountId, accountId);
  return {
    /** Queues the request unless this head already has one of its kind; whether it queued. */
    async queue(reviewRepoId: string, number: number, head: string, kind: GenerateKind) {
      const result = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number, head, kind })
        .onConflictDoNothing({ target: [j.reviewRepoId, j.number, j.head, j.kind] });
      return changedRows(result) > 0;
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
    /** Records the commit, only while it is still the run that claimed it. */
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

export type ClaimedGenerate = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  head: string;
  kind: GenerateKind;
  attempts: number;
  leaseUntil: Date;
};

/** Claims the request waiting longest, or undefined when none is due. */
export async function claimGenerate(
  db: Db,
  now: Date,
  leaseMs: number,
  dailyCalls: number,
): Promise<ClaimedGenerate | undefined> {
  const j = generateJobs;
  // A run that died keeps its row running until its lease lapses: queued again here.
  await db
    .update(j)
    .set({ state: "queued", leaseUntil: null })
    .where(and(eq(j.state, "running"), lt(j.leaseUntil, now)));
  const due = await db
    .select({ id: j.id })
    .from(j)
    .where(
      and(
        eq(j.state, "queued"),
        or(isNull(j.notBefore), lte(j.notBefore, now)),
        callsLeft(j.accountId, dailyCalls, now),
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
      head: j.head,
      kind: j.kind,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

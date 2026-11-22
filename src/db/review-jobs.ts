import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { reviewJobs, reviewRepos } from "./schema.js";

// The pull requests the server reviews itself (ADR-0046): an account's
// enrolled repositories and their jobs (accountReviewJobs, reached through
// scoped()), and the queries that start from a webhook's repository or
// from the queue, before the account is known.

type ReviewRepo = typeof reviewRepos.$inferSelect;
type NewReviewRepo = Omit<typeof reviewRepos.$inferInsert, "id" | "accountId" | "createdAt">;
export type ReviewJobSummary = typeof reviewJobs.$inferSelect;

export function accountReviewJobs(db: Db, accountId: string) {
  const j = reviewJobs;
  const own = eq(j.accountId, accountId);
  return {
    /**
     * Enrolls a repository for this account, or brings its name and hook
     * secret up to date, in one statement: a new one only while the account
     * has fewer than cap. Undefined at the cap, or when another account
     * enrolled the repository (the unique index decides, not a check).
     */
    async enroll(repo: NewReviewRepo, cap: number): Promise<string | undefined> {
      const t = reviewRepos;
      const [row] = await db
        .insert(t)
        .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${repo.platform}, ${repo.host},
          ${repo.platformRepoId}, ${repo.fullName}, ${repo.webhookSecretHash ?? null}, ${Date.now()}
        WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
          OR EXISTS (SELECT 1 FROM ${t} WHERE account_id = ${accountId} AND platform = ${repo.platform}
            AND host = ${repo.host} AND platform_repo_id = ${repo.platformRepoId})`)
        .onConflictDoUpdate({
          target: [t.platform, t.host, t.platformRepoId],
          set: {
            fullName: sql`excluded.full_name`,
            webhookSecretHash: sql`excluded.webhook_secret_hash`,
          },
          setWhere: eq(t.accountId, accountId),
        })
        .returning({ id: t.id });
      return row?.id;
    },

    /**
     * Queues a review of the pull request's head unless it has one, and
     * supersedes the queued reviews of its older heads; returns whether it queued.
     */
    async queue(reviewRepoId: string, number: number, head: string, now: Date): Promise<boolean> {
      const result = await db
        .insert(j)
        .values({ id: crypto.randomUUID(), accountId, reviewRepoId, number, head, createdAt: now })
        .onConflictDoNothing({ target: [j.reviewRepoId, j.number, j.head] });
      await db
        .update(j)
        .set({ state: "superseded", finishedAt: now })
        .where(
          and(
            own,
            eq(j.reviewRepoId, reviewRepoId),
            eq(j.number, number),
            ne(j.head, head),
            eq(j.state, "queued"),
          ),
        );
      return changedRows(result) > 0;
    },

    /** Each repository's newest job. */
    latestJobs(): Promise<ReviewJobSummary[]> {
      const newest = sql`${j.createdAt} = (SELECT max(n.created_at) FROM ${j} n WHERE n.review_repo_id = ${j.reviewRepoId})`;
      return db.select().from(j).where(and(own, newest));
    },

    /**
     * Records the job's review, only while it is still the run that claimed
     * it (attempts unchanged). Returns whether it was recorded.
     */
    async finishJob(id: string, attempts: number, reviewId: string | null, now: Date) {
      const result = await db
        .update(j)
        .set({ state: "done", reviewId, error: null, leaseUntil: null, finishedAt: now })
        .where(and(own, eq(j.id, id), eq(j.state, "running"), eq(j.attempts, attempts)));
      return changedRows(result) > 0;
    },

    /** Queues the job again at retryAt, or gives it up with the error when retryAt is null. */
    async releaseJob(id: string, attempts: number, error: string, retryAt: Date | null, now: Date) {
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

/** The enrolled repository on this platform repository, whichever account enrolled it. */
export function reviewRepoFor(
  db: Db,
  platform: ReviewRepo["platform"],
  host: string,
  platformRepoId: string,
): Promise<ReviewRepo | undefined> {
  const t = reviewRepos;
  return db
    .select()
    .from(t)
    .where(and(eq(t.platform, platform), eq(t.host, host), eq(t.platformRepoId, platformRepoId)))
    .limit(1)
    .then(first);
}

/** A job this runner now owns, until leaseUntil. */
export type ClaimedJob = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  number: number;
  head: string;
  attempts: number;
  leaseUntil: Date;
};

/**
 * Claims a review: of the pull request waiting longest, its newest queued
 * head (the older ones are superseded, a lapsed run's included), unless
 * that pull request has a review running under a live lease, so one pull
 * request is reviewed once at a time. The claim is a compare-and-set on
 * the queued state, so two runners never own one job.
 */
export async function claimJob(
  db: Db,
  now: Date,
  leaseMs: number,
): Promise<ClaimedJob | undefined> {
  const j = reviewJobs;
  const due = and(eq(j.state, "queued"), or(isNull(j.notBefore), lte(j.notBefore, now)));
  const busy = sql`EXISTS (SELECT 1 FROM ${j} r WHERE r.review_repo_id = ${j.reviewRepoId}
    AND r.number = ${j.number} AND r.state = 'running' AND r.lease_until > ${now.getTime()})`;
  // A run that died keeps its row running until its lease lapses: queued again here.
  await db
    .update(j)
    .set({ state: "queued", leaseUntil: null })
    .where(and(eq(j.state, "running"), lt(j.leaseUntil, now)));
  const waiting = await db
    .select({ reviewRepoId: j.reviewRepoId, number: j.number })
    .from(j)
    .where(and(due, sql`NOT ${busy}`))
    .orderBy(j.createdAt)
    .limit(1)
    .then(first);
  if (!waiting) return undefined;
  const pull = and(eq(j.reviewRepoId, waiting.reviewRepoId), eq(j.number, waiting.number));
  const [newest, ...older] = await db
    .select({ id: j.id })
    .from(j)
    .where(and(due, pull))
    .orderBy(desc(j.createdAt));
  if (!newest) return undefined;
  if (older.length > 0) {
    await db
      .update(j)
      .set({ state: "superseded", finishedAt: now })
      .where(
        and(
          eq(j.state, "queued"),
          inArray(
            j.id,
            older.map((o) => o.id),
          ),
        ),
      );
  }
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const [claimed] = await db
    .update(j)
    .set({ state: "running", leaseUntil, attempts: sql`${j.attempts} + 1` })
    .where(and(eq(j.id, newest.id), eq(j.state, "queued")))
    .returning({
      id: j.id,
      accountId: j.accountId,
      reviewRepoId: j.reviewRepoId,
      number: j.number,
      head: j.head,
      attempts: j.attempts,
    });
  return claimed ? { ...claimed, leaseUntil } : undefined;
}

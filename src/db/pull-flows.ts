import { and, asc, desc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.js";
import { countWhere } from "./dialect.js";
import { closedPulls, pullFlows, pullReviews, reviewRepos } from "./schema.js";

// How an enrolled repository's pull requests moved toward review, from its
// platform's webhooks (src/auto-review/flows.ts). A delivery merges into the
// pull request's one row in the statement itself: a first time keeps the
// earliest delivered, so a redelivery or a late older event changes
// nothing; a review is kept once per platform review.

export type FlowEvent = {
  reviewRepoId: string;
  number: number;
  title: string;
  author: string | null;
  /** The platform's id of the author, where the event names it. */
  authorId?: string | null;
  draft: boolean;
  size: number | null;
  openedAt?: Date | null;
  readyAt?: Date | null;
  reopenedAt?: Date | null;
  firstReviewRequestedAt?: Date | null;
  seenAt: Date;
};

export type FlowReview = {
  reviewKey: string;
  reviewer: string;
  approved: boolean;
  submittedAt: Date;
};

const MAX_TITLE = 256;
const MAX_LOGIN = 255;

const t = pullFlows;
const name = (c: SQLiteColumn) => sql.raw(`excluded.${c.name}`);
const earliest = (c: SQLiteColumn) =>
  sql`CASE WHEN ${c} IS NULL OR ${name(c)} < ${c} THEN ${name(c)} ELSE ${c} END`;
const latest = (c: SQLiteColumn) =>
  sql`CASE WHEN ${c} IS NULL OR ${name(c)} > ${c} THEN ${name(c)} ELSE ${c} END`;

export function accountPullFlows(db: Db, accountId: string) {
  const ofRepos = (column: SQLiteColumn, repoIds: readonly string[] | null): SQL | undefined =>
    repoIds ? inArray(column, [...repoIds]) : undefined;

  async function merge(
    e: FlowEvent & { firstReviewAt?: Date | null; firstApprovalAt?: Date | null },
  ): Promise<void> {
    await db
      .insert(t)
      .values({
        id: crypto.randomUUID(),
        accountId,
        reviewRepoId: e.reviewRepoId,
        number: e.number,
        title: [...e.title].slice(0, MAX_TITLE).join(""),
        author: e.author?.slice(0, MAX_LOGIN) ?? null,
        authorId: e.authorId ?? null,
        draft: e.draft,
        size: e.size,
        openedAt: e.openedAt ?? null,
        readyAt: e.readyAt ?? null,
        reopenedAt: e.reopenedAt ?? null,
        firstReviewRequestedAt: e.firstReviewRequestedAt ?? null,
        firstReviewAt: e.firstReviewAt ?? null,
        firstApprovalAt: e.firstApprovalAt ?? null,
        seenAt: e.seenAt,
      })
      .onConflictDoUpdate({
        target: [t.reviewRepoId, t.number],
        set: {
          title: sql`excluded.title`,
          author: sql`coalesce(excluded.author, ${t.author})`,
          authorId: sql`coalesce(excluded.author_id, ${t.authorId})`,
          size: sql`coalesce(excluded.size, ${t.size})`,
          // The newest event says whether it is a draft now.
          draft: sql`CASE WHEN ${name(t.seenAt)} >= ${t.seenAt} THEN excluded.draft ELSE ${t.draft} END`,
          openedAt: earliest(t.openedAt),
          readyAt: earliest(t.readyAt),
          reopenedAt: latest(t.reopenedAt),
          firstReviewRequestedAt: earliest(t.firstReviewRequestedAt),
          firstReviewAt: earliest(t.firstReviewAt),
          firstApprovalAt: earliest(t.firstApprovalAt),
          seenAt: latest(t.seenAt),
        },
        setWhere: eq(t.accountId, accountId),
      });
  }

  return {
    /** Merges a pull request event into its row. */
    record: (e: FlowEvent) => merge(e),

    /** Keeps a review once and moves its pull request's first review (and approval) earlier. */
    async review(e: FlowEvent, review: FlowReview): Promise<void> {
      await db
        .insert(pullReviews)
        .values({
          id: crypto.randomUUID(),
          accountId,
          reviewRepoId: e.reviewRepoId,
          number: e.number,
          reviewKey: review.reviewKey,
          reviewer: review.reviewer.slice(0, MAX_LOGIN),
          approved: review.approved,
          submittedAt: review.submittedAt,
        })
        .onConflictDoNothing({ target: [pullReviews.reviewRepoId, pullReviews.reviewKey] });
      await merge({
        ...e,
        firstReviewAt: review.submittedAt,
        firstApprovalAt: review.approved ? review.submittedAt : null,
      });
    },

    /** The pull requests that had an event since, newest first, up to cap. */
    flowsSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      return db
        .select({
          openedAt: t.openedAt,
          readyAt: t.readyAt,
          firstReviewAt: t.firstReviewAt,
          firstApprovalAt: t.firstApprovalAt,
          size: t.size,
        })
        .from(t)
        .where(
          and(eq(t.accountId, accountId), gte(t.seenAt, since), ofRepos(t.reviewRepoId, repoIds)),
        )
        .orderBy(desc(t.seenAt))
        .limit(cap);
    },

    /** Merged since, with when each was first approved where known, newest first, up to cap. */
    mergedSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      const c = closedPulls;
      return db
        .select({ closedAt: c.closedAt, firstApprovalAt: t.firstApprovalAt })
        .from(c)
        .leftJoin(
          t,
          and(
            eq(t.reviewRepoId, c.reviewRepoId),
            eq(t.number, c.number),
            eq(t.accountId, accountId),
          ),
        )
        .where(
          and(
            eq(c.accountId, accountId),
            gte(c.closedAt, since),
            eq(c.merged, true),
            ofRepos(c.reviewRepoId, repoIds),
          ),
        )
        .orderBy(desc(c.closedAt))
        .limit(cap);
    },

    /** Open, out of draft and not yet reviewed, waiting longest first. */
    waiting(repoIds: readonly string[] | null, limit: number) {
      const c = closedPulls;
      const since = sql`coalesce(${t.readyAt}, ${t.openedAt}, ${t.seenAt})`;
      return db
        .select({
          repo: reviewRepos.fullName,
          number: t.number,
          title: t.title,
          author: t.author,
          since: sql<number>`${since}`.mapWith(Number),
          requestedAt: t.firstReviewRequestedAt,
        })
        .from(t)
        .innerJoin(
          reviewRepos,
          and(eq(reviewRepos.id, t.reviewRepoId), eq(reviewRepos.accountId, accountId)),
        )
        .leftJoin(
          c,
          and(
            eq(c.reviewRepoId, t.reviewRepoId),
            eq(c.number, t.number),
            eq(c.accountId, accountId),
          ),
        )
        .where(
          and(
            eq(t.accountId, accountId),
            eq(t.draft, false),
            isNull(t.firstReviewAt),
            or(isNull(c.id), lt(c.closedAt, t.reopenedAt)),
            ofRepos(t.reviewRepoId, repoIds),
          ),
        )
        .orderBy(asc(since))
        .limit(limit);
    },

    /** Reviews submitted since, per reviewer, most first, up to limit. */
    reviewersSince(since: Date, repoIds: readonly string[] | null, limit: number) {
      const r = pullReviews;
      const reviews = sql<number>`count(*)`.mapWith(Number);
      return db
        .select({
          login: r.reviewer,
          reviews,
          approvals: countWhere(eq(r.approved, true)).mapWith(Number),
          pulls: sql<number>`count(DISTINCT ${r.reviewRepoId} || ':' || ${r.number})`.mapWith(
            Number,
          ),
        })
        .from(r)
        .where(
          and(
            eq(r.accountId, accountId),
            gte(r.submittedAt, since),
            ofRepos(r.reviewRepoId, repoIds),
          ),
        )
        .groupBy(r.reviewer)
        .orderBy(desc(reviews), asc(r.reviewer))
        .limit(limit);
    },
  };
}

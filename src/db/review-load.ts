import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.js";
import { closedPulls, pullFlows, pullReviews, reviewRequests } from "./schema.js";

// Who carries the review work of an account's enrolled repositories, from
// what their webhooks recorded (src/review-load.ts): asks of a reviewer by
// login, the reviews submitted, the asks still open and the pull requests
// authored. Counts are grouped here; times come back as bounded rows.

const r = reviewRequests;
const v = pullReviews;
const f = pullFlows;
const c = closedPulls;

const count = sql<number>`count(*)`.mapWith(Number);

export function accountReviewLoad(db: Db, accountId: string) {
  const ofRepos = (column: SQLiteColumn, repoIds: readonly string[] | null): SQL | undefined =>
    repoIds ? inArray(column, [...repoIds]) : undefined;

  return {
    /** Asks made since of a reviewer whose login is known, newest first, up to cap. */
    asksSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      return db
        .select({
          login: sql<string>`${r.reviewer}`,
          reviewRepoId: r.reviewRepoId,
          number: r.number,
          requestedAt: r.requestedAt,
        })
        .from(r)
        .where(
          and(
            eq(r.accountId, accountId),
            gte(r.requestedAt, since),
            isNotNull(r.reviewer),
            ofRepos(r.reviewRepoId, repoIds),
          ),
        )
        .orderBy(desc(r.requestedAt))
        .limit(cap);
    },

    /** Reviews submitted since, newest first, up to cap. */
    reviewsSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      return db
        .select({
          login: v.reviewer,
          reviewRepoId: v.reviewRepoId,
          number: v.number,
          submittedAt: v.submittedAt,
        })
        .from(v)
        .where(
          and(
            eq(v.accountId, accountId),
            gte(v.submittedAt, since),
            ofRepos(v.reviewRepoId, repoIds),
          ),
        )
        .orderBy(desc(v.submittedAt))
        .limit(cap);
    },

    /** Per login, the asks that wait now on open pull requests out of draft, most first. */
    openAsks(repoIds: readonly string[] | null, limit: number) {
      return db
        .select({ login: sql<string>`${r.reviewer}`, open: count })
        .from(r)
        .leftJoin(
          f,
          and(
            eq(f.reviewRepoId, r.reviewRepoId),
            eq(f.number, r.number),
            eq(f.accountId, accountId),
          ),
        )
        .leftJoin(
          c,
          and(
            eq(c.reviewRepoId, r.reviewRepoId),
            eq(c.number, r.number),
            eq(c.accountId, accountId),
          ),
        )
        .where(
          and(
            eq(r.accountId, accountId),
            isNotNull(r.reviewer),
            or(isNull(r.doneAt), lt(r.doneAt, r.requestedAt)),
            or(isNull(f.id), eq(f.draft, false)),
            or(isNull(c.id), lt(c.closedAt, r.requestedAt), lt(c.closedAt, f.reopenedAt)),
            ofRepos(r.reviewRepoId, repoIds),
          ),
        )
        .groupBy(r.reviewer)
        .orderBy(desc(count), r.reviewer)
        .limit(limit);
    },

    /** Per author login, the pull requests opened since, most first. */
    authoredSince(since: Date, repoIds: readonly string[] | null, limit: number) {
      return db
        .select({ login: sql<string>`${f.author}`, authored: count })
        .from(f)
        .where(
          and(
            eq(f.accountId, accountId),
            // An event is never before it opened: the index finds the rest.
            gte(f.seenAt, since),
            gte(f.openedAt, since),
            isNotNull(f.author),
            ofRepos(f.reviewRepoId, repoIds),
          ),
        )
        .groupBy(f.author)
        .orderBy(desc(count), f.author)
        .limit(limit);
    },

    /**
     * The pull requests that may have waited for a first review in the
     * window: an event since, or no review yet; newest event first, up to cap.
     */
    waitsSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      return db
        .select({
          readyAt: sql<number | null>`coalesce(${f.readyAt}, ${f.openedAt})`.mapWith((x) =>
            x === null ? null : Number(x),
          ),
          firstReviewAt: f.firstReviewAt,
          draft: f.draft,
          reopenedAt: f.reopenedAt,
          closedAt: c.closedAt,
        })
        .from(f)
        .leftJoin(
          c,
          and(
            eq(c.reviewRepoId, f.reviewRepoId),
            eq(c.number, f.number),
            eq(c.accountId, accountId),
          ),
        )
        .where(
          and(
            eq(f.accountId, accountId),
            or(gte(f.seenAt, since), isNull(f.firstReviewAt)),
            ofRepos(f.reviewRepoId, repoIds),
          ),
        )
        .orderBy(desc(f.seenAt))
        .limit(cap);
    },
  };
}

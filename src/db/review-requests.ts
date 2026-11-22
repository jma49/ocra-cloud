import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { CodePlatformKind as CodePlatform } from "../shared/index.js";
import type { Db } from "./client.js";
import { closedPulls, pullFlows, reviewRepos, reviewRequests } from "./schema.js";

// The reviews asked of users on an enrolled repository's pull requests, from
// its platform's webhooks (src/auto-review/requests.ts), and what of them,
// and of the user's own pull requests, still waits (src/notify/reminders.ts).
// An ask merges into its row in the statement itself, so a redelivery or a
// late older event changes nothing; nothing here reads the platform.

/** Whose reviews and pull requests: the platform's id of the user there. */
export type PlatformUser = { platform: CodePlatform; host: string; userId: string };

export type Waiting = {
  reviewRepoId: string;
  platform: CodePlatform;
  repo: string;
  number: number;
  title: string | null;
  /** When it started waiting, ms since the epoch. */
  since: number;
};

const r = reviewRequests;
const f = pullFlows;
const c = closedPulls;

export function accountReviewRequests(db: Db, accountId: string) {
  const ofRepo = (u: PlatformUser) =>
    and(
      eq(reviewRepos.accountId, accountId),
      eq(reviewRepos.platform, u.platform),
      eq(reviewRepos.host, u.host),
    );
  type Pull = { reviewRepoId: SQLiteColumn; number: SQLiteColumn };
  const flowOf = (p: Pull) =>
    and(eq(f.reviewRepoId, p.reviewRepoId), eq(f.number, p.number), eq(f.accountId, accountId));
  const closeOf = (p: Pull) =>
    and(eq(c.reviewRepoId, p.reviewRepoId), eq(c.number, p.number), eq(c.accountId, accountId));

  return {
    /** Records that a review of the pull request was asked of reviewerId at; the latest ask is kept. */
    async asked(e: { reviewRepoId: string; number: number; reviewerId: string; at: Date }) {
      await db
        .insert(r)
        .values({ id: crypto.randomUUID(), accountId, ...e, requestedAt: e.at })
        .onConflictDoUpdate({
          target: [r.reviewRepoId, r.number, r.reviewerId],
          set: {
            requestedAt: sql`CASE WHEN excluded.requested_at > ${r.requestedAt} THEN excluded.requested_at ELSE ${r.requestedAt} END`,
          },
          setWhere: eq(r.accountId, accountId),
        });
    },

    /** Records that reviewerId reviewed the pull request, or was no longer asked, at; the latest is kept. */
    async done(e: { reviewRepoId: string; number: number; reviewerId: string; at: Date }) {
      await db
        .update(r)
        .set({
          doneAt: sql`CASE WHEN ${r.doneAt} IS NULL OR ${r.doneAt} < ${e.at.getTime()} THEN ${e.at.getTime()} ELSE ${r.doneAt} END`,
        })
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.reviewRepoId, e.reviewRepoId),
            eq(r.number, e.number),
            eq(r.reviewerId, e.reviewerId),
          ),
        );
    },

    /**
     * The open pull requests that asked u's review between from and to and
     * still wait for it, waiting longest first; drafts are left out.
     */
    async askedOf(u: PlatformUser, from: Date, to: Date, limit: number): Promise<Waiting[]> {
      return db
        .select({
          reviewRepoId: r.reviewRepoId,
          platform: reviewRepos.platform,
          repo: reviewRepos.fullName,
          number: r.number,
          title: f.title,
          since: sql<number>`${r.requestedAt}`.mapWith(Number),
        })
        .from(r)
        .innerJoin(reviewRepos, and(eq(reviewRepos.id, r.reviewRepoId), ofRepo(u)))
        .leftJoin(f, flowOf(r))
        .leftJoin(c, closeOf(r))
        .where(
          and(
            eq(r.accountId, accountId),
            gte(r.requestedAt, from),
            lte(r.requestedAt, to),
            eq(r.reviewerId, u.userId),
            or(isNull(r.doneAt), lt(r.doneAt, r.requestedAt)),
            or(isNull(f.id), eq(f.draft, false)),
            // Asked again after a close, or reopened since, it is open.
            or(isNull(c.id), lt(c.closedAt, r.requestedAt), lt(c.closedAt, f.reopenedAt)),
          ),
        )
        .orderBy(asc(r.requestedAt))
        .limit(limit);
    },

    /**
     * u's own open pull requests, out of draft and without any review, that
     * have waited since between from and to, waiting longest first.
     */
    async unreviewedOf(u: PlatformUser, from: Date, to: Date, limit: number): Promise<Waiting[]> {
      const since = sql`coalesce(${f.reopenedAt}, ${f.readyAt}, ${f.openedAt})`;
      return db
        .select({
          reviewRepoId: f.reviewRepoId,
          platform: reviewRepos.platform,
          repo: reviewRepos.fullName,
          number: f.number,
          title: f.title,
          since: sql<number>`${since}`.mapWith(Number),
        })
        .from(f)
        .innerJoin(reviewRepos, and(eq(reviewRepos.id, f.reviewRepoId), ofRepo(u)))
        .leftJoin(c, closeOf(f))
        .where(
          and(
            eq(f.accountId, accountId),
            // An event is never before it opened: the index finds the rest.
            gte(f.seenAt, from),
            eq(f.authorId, u.userId),
            eq(f.draft, false),
            isNull(f.firstReviewAt),
            or(isNull(c.id), lt(c.closedAt, f.reopenedAt)),
            sql`${since} >= ${from.getTime()}`,
            sql`${since} <= ${to.getTime()}`,
          ),
        )
        .orderBy(asc(since))
        .limit(limit);
    },
  };
}

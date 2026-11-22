import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ReviewTargets } from "../shared/index.js";
import { changedRows, type Db } from "./client.js";
import { closedPulls, pullFlows, reviewRepos, reviewRequests, reviewTargets } from "./schema.js";

// The account's review targets, set in one upsert per scope (the unique
// (account, scope) row), a repository's only while the account enrolls it;
// and the open pull requests out of draft that the targets are read
// against, from what the enrolled repositories' webhooks stored.

export const DEFAULT_SCOPE = "default";

const t = reviewTargets;
const f = pullFlows;
const c = closedPulls;
const r = reviewRequests;

export type OpenPull = {
  reviewRepoId: string;
  platform: "github" | "gitlab";
  repo: string;
  number: number;
  title: string;
  author: string | null;
  /** When it was ready for review: out of draft, or opened. */
  readyAt: number;
  reopenedAt: number | null;
  firstReviewAt: number | null;
};

/** Asks read for one listing of waiting reviewers. */
const ASKS = 2_000;

const ms = (column: SQLiteColumn | SQL) => sql<number | null>`${column}`.mapWith(Number);

export function accountReviewTargets(db: Db, accountId: string) {
  const own = eq(t.accountId, accountId);
  return {
    /** Sets the default's targets. */
    async setDefault(targets: ReviewTargets, now: Date): Promise<void> {
      await db
        .insert(t)
        .values({
          id: crypto.randomUUID(),
          accountId,
          scope: DEFAULT_SCOPE,
          reviewRepoId: null,
          ...targets,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [t.accountId, t.scope],
          set: { ...targets, updatedAt: now },
        });
    },

    /** Sets an enrolled repository's own targets; false when the account does not enroll it. */
    async setRepo(reviewRepoId: string, targets: ReviewTargets, now: Date): Promise<boolean> {
      const res = await db
        .insert(t)
        .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${reviewRepoId}, ${reviewRepoId},
          ${targets.firstReviewHours}, ${targets.mergeDays}, ${now.getTime()}, ${now.getTime()}
        WHERE EXISTS (SELECT 1 FROM ${reviewRepos} WHERE id = ${reviewRepoId} AND account_id = ${accountId})`)
        .onConflictDoUpdate({
          target: [t.accountId, t.scope],
          set: { ...targets, updatedAt: now },
        });
      return changedRows(res) > 0;
    },

    /** Drops a repository's own targets, so it takes the default; whether it had any. */
    async clearRepo(reviewRepoId: string): Promise<boolean> {
      const res = await db.delete(t).where(and(own, eq(t.scope, reviewRepoId)));
      return changedRows(res) > 0;
    },

    /**
     * The open pull requests out of draft with an event since, of repoIds
     * (or every enrolled repository), ready longest ago first, up to cap.
     */
    async openPulls(since: Date, repoIds: readonly string[] | null, cap: number) {
      const ready = sql`coalesce(${f.readyAt}, ${f.openedAt})`;
      return db
        .select({
          reviewRepoId: f.reviewRepoId,
          platform: reviewRepos.platform,
          repo: reviewRepos.fullName,
          number: f.number,
          title: f.title,
          author: f.author,
          readyAt: sql<number>`${ready}`.mapWith(Number),
          reopenedAt: ms(f.reopenedAt),
          firstReviewAt: ms(f.firstReviewAt),
        })
        .from(f)
        .innerJoin(
          reviewRepos,
          and(eq(reviewRepos.id, f.reviewRepoId), eq(reviewRepos.accountId, accountId)),
        )
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
            gte(f.seenAt, since),
            eq(f.draft, false),
            sql`${ready} IS NOT NULL`,
            or(isNull(c.id), lt(c.closedAt, f.reopenedAt)),
            repoIds ? inArray(f.reviewRepoId, [...repoIds]) : undefined,
          ),
        )
        .orderBy(asc(ready))
        .limit(cap) as Promise<OpenPull[]>;
    },

    /** The logins asked for a review of these pull requests that have not given one since. */
    async waitingOn(pulls: readonly { reviewRepoId: string; number: number }[]) {
      if (pulls.length === 0) return [];
      const rows = await db
        .select({ reviewRepoId: r.reviewRepoId, number: r.number, login: r.reviewer })
        .from(r)
        .where(
          and(
            eq(r.accountId, accountId),
            inArray(r.reviewRepoId, [...new Set(pulls.map((p) => p.reviewRepoId))]),
            inArray(r.number, [...new Set(pulls.map((p) => p.number))]),
            or(isNull(r.doneAt), lt(r.doneAt, r.requestedAt)),
          ),
        )
        .orderBy(asc(r.requestedAt))
        .limit(ASKS);
      return rows.flatMap((row) => (row.login ? [{ ...row, login: row.login }] : []));
    },
  };
}

/** The accounts with a target set, read across accounts by the hourly run. */
export async function targetAccounts(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: t.accountId })
    .from(t)
    .where(or(isNotNull(t.firstReviewHours), isNotNull(t.mergeDays)));
  return rows.map((row) => row.accountId);
}

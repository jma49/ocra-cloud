import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import type { RepoScope } from "./scheduled-reports.js";
import { closedPulls, reviewRepos } from "./schema.js";

// How an enrolled repository's pull requests ended, as its platform's
// webhook said (src/auto-review/closes.ts): one row per pull request, so a
// webhook delivered twice records it once, and a newer close (after a
// reopen) replaces an older one, compared in the statement itself.

export type PullClose = {
  reviewRepoId: string;
  number: number;
  title: string;
  merged: boolean;
  openedAt: Date | null;
  closedAt: Date;
};

export type MergedPull = { repo: string; number: number; title: string; toMergeMs: number | null };

const MAX_TITLE = 256;

export function accountClosedPulls(db: Db, accountId: string) {
  const t = closedPulls;
  const between = (from: Date, to: Date, scope?: RepoScope) =>
    and(
      eq(t.accountId, accountId),
      gte(t.closedAt, from),
      lt(t.closedAt, to),
      scope ? inArray(t.reviewRepoId, [...scope.repoIds]) : undefined,
    );
  return {
    /** Records the close unless the pull request's stored one is newer. */
    async record(close: PullClose): Promise<void> {
      await db
        .insert(t)
        .values({
          ...close,
          id: crypto.randomUUID(),
          accountId,
          title: [...close.title].slice(0, MAX_TITLE).join(""),
        })
        .onConflictDoUpdate({
          target: [t.reviewRepoId, t.number],
          set: {
            title: sql`excluded.title`,
            merged: sql`excluded.merged`,
            openedAt: sql`excluded.opened_at`,
            closedAt: sql`excluded.closed_at`,
          },
          setWhere: sql`${eq(t.accountId, accountId)} AND ${lt(t.closedAt, sql`excluded.closed_at`)}`,
        });
    },

    /** Records the close only when the pull request has none: the webhook's, earlier or later, stands. */
    async fill(close: PullClose): Promise<boolean> {
      const added = await db
        .insert(t)
        .values({
          ...close,
          id: crypto.randomUUID(),
          accountId,
          title: [...close.title].slice(0, MAX_TITLE).join(""),
        })
        .onConflictDoNothing({ target: [t.reviewRepoId, t.number] });
      return changedRows(added) > 0;
    },

    /** How many were merged between from and to, and the newest of them, up to limit. */
    async mergedBetween(from: Date, to: Date, limit: number, scope?: RepoScope) {
      const where = and(between(from, to, scope), eq(t.merged, true));
      const [counted, newest] = await Promise.all([
        db.select({ n: sql<number>`count(*)` }).from(t).where(where),
        limit > 0
          ? db
              .select({
                repo: reviewRepos.fullName,
                number: t.number,
                title: t.title,
                openedAt: t.openedAt,
                closedAt: t.closedAt,
              })
              .from(t)
              .innerJoin(reviewRepos, eq(reviewRepos.id, t.reviewRepoId))
              .where(and(where, eq(reviewRepos.accountId, accountId)))
              .orderBy(desc(t.closedAt))
              .limit(limit)
          : Promise.resolve([]),
      ]);
      return {
        merged: Number(counted[0]?.n ?? 0),
        newest: newest.map(
          (p): MergedPull => ({
            repo: p.repo,
            number: p.number,
            title: p.title,
            toMergeMs: p.openedAt ? Math.max(0, p.closedAt.getTime() - p.openedAt.getTime()) : null,
          }),
        ),
      };
    },

    /** Opened to merged, for every pull request merged between from and to that says when it opened. */
    async mergeTimes(from: Date, to: Date, cap: number, scope?: RepoScope): Promise<number[]> {
      const rows = await db
        .select({ openedAt: t.openedAt, closedAt: t.closedAt })
        .from(t)
        .where(and(between(from, to, scope), eq(t.merged, true), sql`${t.openedAt} IS NOT NULL`))
        .orderBy(desc(t.closedAt))
        .limit(cap);
      return rows.flatMap((r) =>
        r.openedAt ? [Math.max(0, r.closedAt.getTime() - r.openedAt.getTime())] : [],
      );
    },
  };
}

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { first } from "./client.js";
import { pullPaths, pullReviews } from "./schema.js";

// The directories each reviewed pull request of an enrolled repository
// changes (src/review-paths.ts), and who reviewed pull requests in the
// directories another one changes.

// D1 binds at most 100 parameters to a statement; a row takes eight.
const ROWS_PER_INSERT = 10;

const t = pullPaths;

export function accountPullPaths(db: Db, accountId: string) {
  const ofPull = (reviewRepoId: string, number: number) =>
    and(eq(t.accountId, accountId), eq(t.reviewRepoId, reviewRepoId), eq(t.number, number));

  return {
    /** The head the pull request's directories were read at; null when none are kept. */
    async headOf(reviewRepoId: string, number: number): Promise<string | null> {
      const row = await db
        .select({ head: t.head })
        .from(t)
        .where(ofPull(reviewRepoId, number))
        .limit(1)
        .then(first);
      return row?.head ?? null;
    },

    /** Replaces the pull request's directories with those read at head, in one batch. */
    async keep(
      reviewRepoId: string,
      number: number,
      head: string,
      prefixes: readonly string[],
      seenAt: Date,
    ): Promise<void> {
      const rows = prefixes.map((prefix) => ({
        id: crypto.randomUUID(),
        accountId,
        reviewRepoId,
        number,
        head,
        prefix,
        seenAt,
      }));
      const inserts = Array.from({ length: Math.ceil(rows.length / ROWS_PER_INSERT) }, (_, i) =>
        db
          .insert(t)
          .values(rows.slice(i * ROWS_PER_INSERT, (i + 1) * ROWS_PER_INSERT))
          .onConflictDoNothing({ target: [t.reviewRepoId, t.number, t.prefix] }),
      );
      await db.batch([db.delete(t).where(ofPull(reviewRepoId, number)), ...inserts]);
    },

    /**
     * Per reviewer and directory among prefixes, how many of the
     * repository's pull requests changing it they reviewed since, most first.
     */
    reviewersIn(since: Date, reviewRepoId: string, prefixes: readonly string[], limit: number) {
      if (prefixes.length === 0) return Promise.resolve([]);
      const r = pullReviews;
      const pulls = sql<number>`count(DISTINCT ${r.number})`.mapWith(Number);
      return db
        .select({ login: r.reviewer, prefix: t.prefix, pulls })
        .from(r)
        .innerJoin(
          t,
          and(
            eq(t.reviewRepoId, r.reviewRepoId),
            eq(t.number, r.number),
            eq(t.accountId, accountId),
            inArray(t.prefix, [...prefixes]),
          ),
        )
        .where(
          and(
            eq(r.accountId, accountId),
            eq(r.reviewRepoId, reviewRepoId),
            gte(r.submittedAt, since),
          ),
        )
        .groupBy(r.reviewer, t.prefix)
        .orderBy(desc(pulls), asc(r.reviewer), asc(t.prefix))
        .limit(limit);
    },
  };
}

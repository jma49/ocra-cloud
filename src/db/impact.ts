import { and, desc, eq, gte, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.js";
import { jsonRecords, jsonTexts } from "./dialect.js";
import { closedPulls, findingIssues, findings, pullFlows, reviews } from "./schema.js";

// What ocra changed in an account's enrolled repositories (src/insights-impact.ts):
// its reviews of their pull requests, named by the repository's identity as
// the CLI writes it (lower case here), the webhooks' records of those pull
// requests, and the console's decisions on the findings and issues opened
// from them. Findings are grouped per review here; nothing else is read.

const r = reviews;
const count = sql<number>`count(*)`.mapWith(Number);

export function accountImpact(db: Db, accountId: string) {
  const ofRepos = (column: SQLiteColumn, repoIds: readonly string[] | null): SQL | undefined =>
    repoIds ? inArray(column, [...repoIds]) : undefined;
  const identity = sql<string>`lower(${r.prRepository})`;
  const ofIdentities = (identities: readonly string[]) =>
    sql`${identity} IN (${jsonTexts(db, JSON.stringify(identities))})`;
  const reviewsOf = (since: Date, identities: readonly string[]) =>
    and(eq(r.accountId, accountId), gte(r.createdAt, since), ofIdentities(identities));

  return {
    /** The account's reviews made since of these repositories' pull requests, newest first, up to cap. */
    reviewsSince(since: Date, identities: readonly string[], cap: number) {
      if (identities.length === 0) return Promise.resolve([]);
      return db
        .select({
          id: r.id,
          repo: identity,
          number: r.prNumber,
          createdAt: r.createdAt,
          critical: r.critical,
          warning: r.warning,
          suggestion: r.suggestion,
          fixed: r.fixed,
          dismissed: r.dismissed,
        })
        .from(r)
        .where(and(reviewsOf(since, identities), isNotNull(r.prNumber)))
        .orderBy(desc(r.createdAt))
        .limit(cap);
    },

    /** When the account first reviewed each of these pull requests, of those it reviewed. */
    async firstReviews(pulls: readonly { repo: string; number: number }[]) {
      if (pulls.length === 0) return [];
      const rows = await db
        .select({
          repo: sql<string>`je.repo`,
          number: sql<number>`je.number`.mapWith(Number),
          at: sql<number | null>`(SELECT min(${r.createdAt}) FROM ${r}
            WHERE ${r.accountId} = ${accountId} AND ${r.prNumber} = je.number
              AND lower(${r.prRepository}) = je.repo)`,
        })
        .from(jsonRecords(db, JSON.stringify(pulls), { repo: "text", number: "bigint" }));
      return rows.flatMap((row) =>
        row.at === null ? [] : [{ repo: row.repo, number: row.number, at: Number(row.at) }],
      );
    },

    /** Per review made since, its shared findings by status and how fixed, threads resolved, and issues opened. */
    async findingsSince(since: Date, identities: readonly string[], cap: number) {
      if (identities.length === 0) return { statuses: [], issues: [] };
      const f = findings;
      const i = findingIssues;
      const [statuses, issues] = await Promise.all([
        db
          .select({
            reviewId: f.reviewId,
            status: f.status,
            fixedVia: f.fixedVia,
            n: count,
            threadResolved:
              sql<number>`sum(CASE WHEN ${f.threadResolvedAt} IS NOT NULL THEN 1 ELSE 0 END)`.mapWith(
                Number,
              ),
          })
          .from(f)
          .innerJoin(r, eq(r.id, f.reviewId))
          .where(and(eq(f.accountId, accountId), reviewsOf(since, identities)))
          .groupBy(f.reviewId, f.status, f.fixedVia)
          .limit(cap),
        db
          .select({ reviewId: i.reviewId, n: count })
          .from(i)
          .innerJoin(r, eq(r.id, i.reviewId))
          .where(and(eq(i.accountId, accountId), isNotNull(i.number), reviewsOf(since, identities)))
          .groupBy(i.reviewId)
          .limit(cap),
      ]);
      return { statuses, issues };
    },

    /** Pull requests opened since, newest first, up to cap. */
    openedSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      const t = pullFlows;
      return db
        .select({ reviewRepoId: t.reviewRepoId, number: t.number, openedAt: t.openedAt })
        .from(t)
        .where(
          and(
            eq(t.accountId, accountId),
            gte(t.seenAt, since),
            gte(t.openedAt, since),
            ofRepos(t.reviewRepoId, repoIds),
          ),
        )
        .orderBy(desc(t.seenAt))
        .limit(cap);
    },

    /** Merged since, with when each opened where known, newest first, up to cap. */
    mergedSince(since: Date, repoIds: readonly string[] | null, cap: number) {
      const c = closedPulls;
      const t = pullFlows;
      return db
        .select({
          reviewRepoId: c.reviewRepoId,
          number: c.number,
          openedAt: sql<number | null>`coalesce(${c.openedAt}, ${t.openedAt})`,
          closedAt: c.closedAt,
        })
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
  };
}

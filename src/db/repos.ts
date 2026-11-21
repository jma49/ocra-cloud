import { and, count, desc, eq, gte, max, sql, sum } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { findings, repositories, reviews } from "./schema.js";

// The account's repositories: the hashes its reviews came from, summed in
// SQL, and the names it gave them. Reached only through scoped().

/** Per repository hash reviewed since a time: reviews, findings, open findings, last review. */
export async function reviewedRepos(db: DrizzleD1Database, accountId: string, since: Date) {
  const r = reviews;
  const f = findings;
  const [byRepo, open] = await db.batch([
    db
      .select({
        repoHash: r.repoHash,
        reviews: count(),
        findings: sql<number>`coalesce(${sum(r.findings)}, 0)`,
        lastReviewAt: max(r.createdAt),
      })
      .from(r)
      .where(and(eq(r.accountId, accountId), gte(r.createdAt, since)))
      .groupBy(r.repoHash)
      .orderBy(desc(max(r.createdAt))),
    db
      .select({ repoHash: r.repoHash, n: count() })
      .from(f)
      .innerJoin(r, and(eq(r.id, f.reviewId), eq(r.accountId, accountId)))
      .where(and(eq(f.accountId, accountId), eq(f.status, "open")))
      .groupBy(r.repoHash),
  ]);
  const openBy = new Map(open.map((o) => [o.repoHash, o.n]));
  return byRepo.map((x) => ({ ...x, openFindings: openBy.get(x.repoHash) ?? 0 }));
}

/**
 * Names a repository, or renames it, in one statement: a new name only
 * while the account has fewer than cap. Returns whether it was stored.
 */
export async function nameRepo(
  db: DrizzleD1Database,
  accountId: string,
  repoHash: string,
  name: string,
  cap: number,
): Promise<boolean> {
  const t = repositories;
  const renamed = await db
    .update(t)
    .set({ name })
    .where(and(eq(t.accountId, accountId), eq(t.repoHash, repoHash)))
    .run();
  if (renamed.meta.changes > 0) return true;
  const inserted = await db.run(sql`
    INSERT INTO ${t} (id, account_id, repo_hash, name)
    SELECT ${crypto.randomUUID()}, ${accountId}, ${repoHash}, ${name}
    WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
    ON CONFLICT (account_id, repo_hash) DO UPDATE SET name = excluded.name`);
  return inserted.meta.changes > 0;
}

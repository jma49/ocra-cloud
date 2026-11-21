import { and, count, desc, eq, gte, max, sql, sum } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { findings, repositories, reviews } from "./schema.js";

// The account's repositories: the hashes its reviews came from, summed in
// SQL, and the names it gave them. Reached only through scoped().

/** Per repository hash reviewed since a time: reviews, findings, open findings, last review. */
export async function reviewedRepos(db: Db, accountId: string, since: Date) {
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
  db: Db,
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
  if (changedRows(renamed) > 0) return true;
  const inserted = await db.run(sql`
    INSERT INTO ${t} (id, account_id, repo_hash, name)
    SELECT ${crypto.randomUUID()}, ${accountId}, ${repoHash}, ${name}
    WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
    ON CONFLICT (account_id, repo_hash) DO UPDATE SET name = excluded.name`);
  return changedRows(inserted) > 0;
}

/**
 * Names many repositories in one batch: each statement inserts or
 * renames one, a new one only while the account has fewer than cap.
 * Returns how many were stored.
 */
export async function nameRepos(
  db: Db,
  accountId: string,
  list: readonly { repoHash: string; name: string }[],
  cap: number,
): Promise<number> {
  const t = repositories;
  const [first, ...rest] = list.map((r) =>
    db
      .insert(t)
      .select(sql`SELECT ${crypto.randomUUID()}, ${accountId}, ${r.repoHash}, ${r.name},
        unixepoch('subsec') * 1000
      WHERE (SELECT count(*) FROM ${t} WHERE account_id = ${accountId}) < ${cap}
        OR EXISTS (SELECT 1 FROM ${t} WHERE account_id = ${accountId} AND repo_hash = ${r.repoHash})`)
      .onConflictDoUpdate({ target: [t.accountId, t.repoHash], set: { name: sql`excluded.name` } }),
  );
  if (!first) return 0;
  const results = await db.batch([first, ...rest]);
  return results.filter((r) => changedRows(r) > 0).length;
}

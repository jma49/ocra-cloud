import {
  and,
  count,
  desc,
  eq,
  type InferSelectModel,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { accountMemory, findings, reviews } from "./schema.js";

// The findings inbox: every review's findings of one account, filtered and
// paged, and the decisions made on them. Reached only through scoped().

type Finding = InferSelectModel<typeof findings>;

/** Which findings the inbox lists; a field left out matches any value, verification null matches none. */
export type InboxFilter = {
  status?: Finding["status"] | undefined;
  severity?: Finding["severity"] | undefined;
  verification?: Finding["verification"] | undefined;
  reviewer?: string | undefined;
  repoHash?: string | undefined;
};
/** The last listed row's (created_at, id): the next page starts after it. */
export type InboxCursor = { createdAt: Date; id: string };
/** A decision about findings: reopening clears what dismissing set. */
export type Decision = Pick<Finding, "status" | "reason" | "note" | "decidedAt">;

export async function inbox(
  db: DrizzleD1Database,
  accountId: string,
  filter: InboxFilter,
  limit: number,
  after?: InboxCursor,
) {
  const f = findings;
  const r = reviews;
  const conditions: (SQL | undefined)[] = [
    eq(f.accountId, accountId),
    filter.status ? eq(f.status, filter.status) : undefined,
    filter.severity ? eq(f.severity, filter.severity) : undefined,
    filter.verification === null
      ? isNull(f.verification)
      : filter.verification
        ? eq(f.verification, filter.verification)
        : undefined,
    filter.reviewer ? eq(f.reviewer, filter.reviewer) : undefined,
    filter.repoHash ? eq(r.repoHash, filter.repoHash) : undefined,
    after
      ? or(
          lt(f.createdAt, after.createdAt),
          and(eq(f.createdAt, after.createdAt), lt(f.id, after.id)),
        )
      : undefined,
  ];
  const rows = await db
    .select({ finding: f, repoHash: r.repoHash, runId: r.runId })
    .from(f)
    .innerJoin(r, and(eq(r.id, f.reviewId), eq(r.accountId, accountId)))
    .where(and(...conditions))
    .orderBy(desc(f.createdAt), desc(f.id))
    .limit(limit)
    .all();
  const last = rows.at(-1);
  return {
    rows,
    next:
      rows.length === limit && last
        ? { createdAt: last.finding.createdAt, id: last.finding.id }
        : null,
  };
}

/** How many of the account's findings have each status. */
export function findingStatusCounts(db: DrizzleD1Database, accountId: string) {
  return db
    .select({ status: findings.status, n: count() })
    .from(findings)
    .where(eq(findings.accountId, accountId))
    .groupBy(findings.status)
    .all();
}

/** Sets one decision on the account's findings with these ids; returns how many changed. */
export async function decide(
  db: DrizzleD1Database,
  accountId: string,
  ids: readonly string[],
  decision: Decision,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .update(findings)
    .set(decision)
    .where(and(eq(findings.accountId, accountId), inArray(findings.id, [...ids])))
    .run();
  return result.meta.changes;
}

/**
 * Remembers the account's findings with these ids, each for its review's
 * repository, in one statement: a fingerprint the repository already has,
 * or one past cap entries for it, is left out, so parallel callers cannot
 * pass a count taken before any of them wrote. Returns how many it added
 * and whether a repository was full.
 */
export async function rememberFindings(
  db: DrizzleD1Database,
  accountId: string,
  ids: readonly string[],
  reason: string,
  cap: number,
): Promise<{ added: number; full: boolean }> {
  if (ids.length === 0) return { added: 0, full: false };
  const list = JSON.stringify([...ids]);
  const result = await db.run(sql`
    INSERT INTO ${accountMemory}
    SELECT lower(hex(randomblob(16))), ${accountId}, repo_hash, fingerprint, file, title, ${reason},
      unixepoch('subsec') * 1000
    FROM (
      SELECT r.repo_hash, f.fingerprint, min(f.file) AS file, min(f.title) AS title,
        row_number() OVER (PARTITION BY r.repo_hash ORDER BY f.fingerprint) AS n
      FROM ${findings} f JOIN ${reviews} r ON r.id = f.review_id AND r.account_id = ${accountId}
      WHERE f.account_id = ${accountId} AND f.id IN (SELECT value FROM json_each(${list}))
        AND NOT EXISTS (SELECT 1 FROM ${accountMemory} m WHERE m.account_id = ${accountId}
          AND m.repo_hash = r.repo_hash AND m.fingerprint = f.fingerprint)
      GROUP BY r.repo_hash, f.fingerprint
    ) AS picked
    WHERE (SELECT count(*) FROM ${accountMemory} m WHERE m.account_id = ${accountId}
      AND m.repo_hash = picked.repo_hash) + n <= ${cap}`);
  const wanted = await db.get<{ n: number }>(sql`
    SELECT count(*) AS n FROM (
      SELECT DISTINCT r.repo_hash, f.fingerprint
      FROM ${findings} f JOIN ${reviews} r ON r.id = f.review_id AND r.account_id = ${accountId}
      WHERE f.account_id = ${accountId} AND f.id IN (SELECT value FROM json_each(${list}))
        AND NOT EXISTS (SELECT 1 FROM ${accountMemory} m WHERE m.account_id = ${accountId}
          AND m.repo_hash = r.repo_hash AND m.fingerprint = f.fingerprint))`);
  return { added: result.meta.changes, full: (wanted?.n ?? 0) > 0 };
}

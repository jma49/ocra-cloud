import {
  and,
  count,
  desc,
  eq,
  gte,
  type InferSelectModel,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PageCursor } from "../page-cursor.js";
import { changedRows, type Db, first } from "./client.js";
import { countWhere, jsonTexts, randomId } from "./dialect.js";
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
  /** null matches the findings that named no rule. */
  rule?: { kind: NonNullable<Finding["ruleKind"]>; id: string } | null | undefined;
};
/** A decision about findings: reopening clears what dismissing set. */
export type Decision = Pick<Finding, "status" | "reason" | "note" | "decidedAt">;

export async function inbox(
  db: Db,
  accountId: string,
  filter: InboxFilter,
  limit: number,
  after?: PageCursor,
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
    filter.rule === null
      ? isNull(f.ruleKind)
      : filter.rule
        ? and(eq(f.ruleKind, filter.rule.kind), eq(f.ruleId, filter.rule.id))
        : undefined,
    after
      ? or(
          lt(f.createdAt, after.createdAt),
          and(eq(f.createdAt, after.createdAt), lt(f.id, after.id)),
        )
      : undefined,
  ];
  const rows = await db
    .select({ finding: f, repoHash: r.repoHash, runId: r.runId, prNumber: r.prNumber })
    .from(f)
    .innerJoin(r, and(eq(r.id, f.reviewId), eq(r.accountId, accountId)))
    .where(and(...conditions))
    .orderBy(desc(f.createdAt), desc(f.id))
    .limit(limit);
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
export function findingStatusCounts(db: Db, accountId: string) {
  return db
    .select({ status: findings.status, n: count() })
    .from(findings)
    .where(eq(findings.accountId, accountId))
    .groupBy(findings.status);
}

/** Sets one decision on the account's findings with these ids; returns how many changed. */
export async function decide(
  db: Db,
  accountId: string,
  ids: readonly string[],
  decision: Decision,
): Promise<number> {
  if (ids.length === 0) return 0;
  const f = findings;
  // Marking a fixed finding fixed again keeps how and when it was fixed.
  const fixedSet =
    decision.status === "fixed"
      ? {
          decidedAt: sql`CASE WHEN ${f.status} = 'fixed' THEN ${f.decidedAt} ELSE ${decision.decidedAt?.getTime() ?? null} END`,
          fixedVia: sql`CASE WHEN ${f.status} = 'fixed' THEN ${f.fixedVia} ELSE 'manual' END`,
        }
      : { fixedVia: null };
  const result = await db
    .update(findings)
    .set({ ...decision, ...fixedSet })
    .where(and(eq(findings.accountId, accountId), inArray(findings.id, [...ids])));
  return changedRows(result);
}

/**
 * Remembers the account's findings with these ids, each for its review's
 * repository, in one statement: a fingerprint the repository already has,
 * or one past cap entries for it, is left out, so parallel callers cannot
 * pass a count taken before any of them wrote. Returns how many it added
 * and whether a repository was full.
 */
export async function rememberFindings(
  db: Db,
  accountId: string,
  ids: readonly string[],
  reason: string,
  cap: number,
): Promise<{ added: number; full: boolean }> {
  if (ids.length === 0) return { added: 0, full: false };
  const list = JSON.stringify([...ids]);
  const result = await db.run(sql`
    INSERT INTO ${accountMemory} (id, account_id, repo_hash, fingerprint, file, title, reason, created_at)
    SELECT ${randomId(db)}, ${accountId}, repo_hash, fingerprint, file, title, ${reason},
      ${Date.now()}
    FROM (
      SELECT r.repo_hash, f.fingerprint, min(f.file) AS file, min(f.title) AS title,
        row_number() OVER (PARTITION BY r.repo_hash ORDER BY f.fingerprint) AS n
      FROM ${findings} f JOIN ${reviews} r ON r.id = f.review_id AND r.account_id = ${accountId}
      WHERE f.account_id = ${accountId} AND f.id IN (${jsonTexts(db, list)})
        AND NOT EXISTS (SELECT 1 FROM ${accountMemory} m WHERE m.account_id = ${accountId}
          AND m.repo_hash = r.repo_hash AND m.fingerprint = f.fingerprint)
      GROUP BY r.repo_hash, f.fingerprint
    ) AS picked
    WHERE (SELECT count(*) FROM ${accountMemory} m WHERE m.account_id = ${accountId}
      AND m.repo_hash = picked.repo_hash) + n <= ${cap}`);
  const wanted = await db
    .select({ n: sql<number>`count(*)` })
    .from(sql`(
      SELECT DISTINCT r.repo_hash, f.fingerprint
      FROM ${findings} f JOIN ${reviews} r ON r.id = f.review_id AND r.account_id = ${accountId}
      WHERE f.account_id = ${accountId} AND f.id IN (${jsonTexts(db, list)})
        AND NOT EXISTS (SELECT 1 FROM ${accountMemory} m WHERE m.account_id = ${accountId}
          AND m.repo_hash = r.repo_hash AND m.fingerprint = f.fingerprint)) AS w`)
    .then(first);
  return { added: changedRows(result), full: (wanted?.n ?? 0) > 0 };
}

/**
 * The account's findings since a time, counted per status in SQL, grouped
 * by reviewer, severity, category, verification, rule (the first ruleRows
 * by findings, and how many there are) and dismissal reason: what
 * the inbox's decisions, and the reactions on ocra's comments, say about
 * each part of the review.
 */
export async function findingInsights(db: Db, accountId: string, since: Date, ruleRows: number) {
  const f = findings;
  const where = and(eq(f.accountId, accountId), gte(f.createdAt, since));
  const tally = {
    total: count(),
    open: countWhere(sql`${f.status} = 'open'`),
    fixed: countWhere(sql`${f.status} = 'fixed'`),
    dismissed: countWhere(sql`${f.status} = 'dismissed'`),
    addressed: countWhere(sql`${f.status} = 'addressed'`),
    merged: countWhere(sql`${f.status} = 'merged'`),
    // A positive signal: fixed, or given a 👍; one finding counts once.
    accepted: countWhere(sql`(${f.status} = 'fixed' OR ${f.thumbsUp} > 0)`),
    thumbsUp: countWhere(sql`${f.thumbsUp} > 0`),
    thumbsDown: countWhere(sql`${f.thumbsDown} > 0`),
    reacted: countWhere(sql`(${f.thumbsUp} > 0 OR ${f.thumbsDown} > 0)`),
  };
  const by = (key: SQL<string | null> | typeof f.reviewer, limit = 50) =>
    db
      .select({ key: sql<string | null>`${key}`, ...tally })
      .from(f)
      .where(where)
      .groupBy(key)
      .orderBy(desc(count()))
      .limit(limit);
  const [all, reviewer, severity, category, verification, reasons, rule, rules] = await db.batch([
    db.select(tally).from(f).where(where),
    by(f.reviewer),
    by(sql`${f.severity}`),
    by(sql`${f.category}`, 20),
    by(sql`${f.verification}`),
    db
      .select({ key: f.reason, n: count() })
      .from(f)
      .where(and(where, eq(f.status, "dismissed")))
      .groupBy(f.reason),
    db
      .select({ kind: f.ruleKind, id: f.ruleId, ...tally })
      .from(f)
      .where(where)
      .groupBy(f.ruleKind, f.ruleId)
      // Ties in one order on every database: named rules first.
      .orderBy(desc(count()), sql`${f.ruleKind} IS NULL`, f.ruleKind, f.ruleId)
      .limit(ruleRows),
    db
      .select({ n: sql<number>`count(*)` })
      .from(
        db
          .select({ kind: f.ruleKind })
          .from(f)
          .where(where)
          .groupBy(f.ruleKind, f.ruleId)
          .as("rules"),
      ),
  ]);
  return {
    all: all[0],
    reviewer,
    severity,
    category,
    verification,
    reasons,
    rule,
    rules: Number(rules[0]?.n ?? 0),
  };
}

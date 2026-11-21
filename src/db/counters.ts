import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { DAY, utcDay } from "../time.js";
import { RETENTION_DAYS } from "./retention.js";
import { budgets, usageCounters } from "./schema.js";

// An account's use, counted as it happens (audit C1): a cap reads the
// account's counter rows, never counts its records, so checking it costs
// the same however much the account stored. Only scoped() calls these.

export type DailyKind = "uploads" | "gateway_calls";

const c = usageCounters;

/**
 * Adds one to the account's count of kind for now's UTC day while that
 * count is under cap; returns whether it did. One statement, so parallel
 * callers cannot all pass: SQLite applies the upserts one at a time. A
 * refusal writes nothing.
 */
export async function countOne(
  db: DrizzleD1Database,
  accountId: string,
  kind: DailyKind,
  cap: number,
  now: Date,
): Promise<boolean> {
  if (!(cap >= 1)) return false;
  const counted = await db
    .insert(c)
    .values({ accountId, kind, day: utcDay(now), n: 1 })
    .onConflictDoUpdate({
      target: [c.accountId, c.kind, c.day],
      set: { n: sql`${c.n} + 1` },
      setWhere: sql`${c.n} < ${cap}`,
    })
    .returning({ n: c.n });
  return counted.length > 0;
}

/**
 * countOne for a gateway call, under the smaller of cap and the account's
 * own daily budget (budgets.daily_calls), read in the same statement.
 */
export async function countCall(
  db: DrizzleD1Database,
  accountId: string,
  cap: number,
  now: Date,
): Promise<boolean> {
  if (!(cap >= 1)) return false;
  const limit = sql`min(${cap}, coalesce((SELECT ${budgets.dailyCalls} FROM ${budgets}
    WHERE ${budgets.accountId} = ${accountId}), ${cap}))`;
  // A day's first call is always within a budget: the smallest is 1.
  const counted = await db
    .insert(c)
    .values({ accountId, kind: "gateway_calls", day: utcDay(now), n: 1 })
    .onConflictDoUpdate({
      target: [c.accountId, c.kind, c.day],
      set: { n: sql`${c.n} + 1` },
      setWhere: sql`${c.n} < ${limit}`,
    })
    .returning({ n: c.n });
  return counted.length > 0;
}

/** Takes back one countOne, for an upload that turned out to be a retry. */
export function uncountOne(
  db: DrizzleD1Database,
  accountId: string,
  kind: DailyKind,
  now: Date,
): Promise<unknown> {
  return db
    .update(c)
    .set({ n: sql`${c.n} - 1` })
    .where(and(eq(c.accountId, accountId), eq(c.kind, kind), eq(c.day, utcDay(now)), gt(c.n, 0)))
    .run();
}

/**
 * The first UTC day whose shared findings still count: retention deletes a
 * review and its findings RETENTION_DAYS after the upload, so the findings
 * counted from here on are at least all those still stored.
 */
const findingsWindowStart = (now: Date): string =>
  utcDay(new Date(now.getTime() - RETENTION_DAYS * DAY));

/** The account's shared findings uploaded since findingsWindowStart, as a subquery. */
export function findingsCounted(accountId: string, now: Date): SQL {
  return sql`(SELECT coalesce(sum(${c.n}), 0) FROM ${c}
    WHERE ${c.accountId} = ${accountId} AND ${c.kind} = 'findings'
      AND ${c.day} >= ${findingsWindowStart(now)})`;
}

/**
 * Adds the findings stored for a review to the account's count for now's
 * day, in the batch that stored them; none stored, nothing is written. The
 * count reads the review's own findings, at most MAX_FINDINGS.
 */
export function countFindingsOf(
  db: DrizzleD1Database,
  accountId: string,
  reviewId: string,
  now: Date,
): BatchItem<"sqlite"> {
  // In the table's column order: insert … select names every column.
  return db
    .insert(c)
    .select(sql`SELECT ${accountId}, 'findings', ${utcDay(now)}, stored,
        unixepoch('subsec') * 1000
      FROM (SELECT count(*) AS stored FROM findings WHERE review_id = ${reviewId})
      WHERE stored > 0`)
    .onConflictDoUpdate({
      target: [c.accountId, c.kind, c.day],
      set: { n: sql`${c.n} + excluded.n` },
    });
}

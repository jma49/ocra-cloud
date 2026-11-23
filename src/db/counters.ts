import { type AnyColumn, and, eq, gt, gte, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { DEFAULT_RETENTION_DAYS } from "../config.js";
import { DEFAULT_SPEND_LIMITS, dailyCallCeiling, LIMIT_OFF } from "../shared/index.js";
import { DAY, utcDay, utcMonthStartDay } from "../time.js";
import type { Db } from "./client.js";
import { budgets, usageCounters } from "./schema.js";

// An account's use, counted as it happens (audit C1): a cap reads the
// account's counter rows, never counts its records, so checking it costs
// the same however much the account stored. Only scoped() calls these.

export type DailyKind =
  | "uploads"
  | "gateway_calls"
  | "email_confirmations"
  | "slack_confirmations"
  | "slack_lookups"
  | "report_sends";

const c = usageCounters;

/**
 * Adds one to the account's count of kind for now's UTC day while that
 * count is under cap; returns whether it did. One statement, so parallel
 * callers cannot all pass: SQLite applies the upserts one at a time. A
 * refusal writes nothing.
 */
export async function countOne(
  db: Db,
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
 * The account's limit on gateway calls a day, as SQL that src/shared's
 * dailyCallLimit mirrors: its own number (budgets.daily_calls), read in the
 * statement that uses it, else the server's default; with its limit off,
 * the server's ceiling.
 */
function callLimit(account: AnyColumn | SQL | string, serviceDefault: number): SQL {
  const own = sql`(SELECT ${budgets.dailyCalls} FROM ${budgets} WHERE ${budgets.accountId} = ${account})`;
  const ceiling = dailyCallCeiling(serviceDefault);
  return sql`CASE WHEN ${own} IS NULL THEN ${serviceDefault} WHEN ${own} = ${LIMIT_OFF} THEN ${ceiling}
    WHEN ${own} < ${ceiling} THEN ${own} ELSE ${ceiling} END`;
}

/** countOne for a gateway call, under the account's call limit. */
export async function countCall(
  db: Db,
  accountId: string,
  serviceDefault: number,
  now: Date,
): Promise<boolean> {
  if (!(serviceDefault >= 1)) return false;
  const limit = callLimit(accountId, serviceDefault);
  // A day's first call is always within a limit: the smallest is 1.
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

/**
 * Whether the account a row names in `account` may still make a gateway
 * call on now's UTC day: countCall's test, without counting. A hosted job
 * of an account that may not would only be refused, so it is not claimed.
 */
function callsLeft(account: AnyColumn | SQL, serviceDefault: number, now: Date): SQL {
  const used = sql`(SELECT ${c.n} FROM ${c} WHERE ${c.accountId} = ${account}
    AND ${c.kind} = 'gateway_calls' AND ${c.day} = ${utcDay(now)})`;
  return sql`coalesce(${used}, 0) < ${callLimit(account, serviceDefault)}`;
}

/** The spend counter's unit: millionths of a US dollar, so the count stays a whole number. */
const MICRO_USD = 1_000_000;

/**
 * Adds what the stored review cost to the account's spend for now's day,
 * in the batch that stores it and only when that review row is there, so a
 * retry of the run counts nothing. Undefined for a review that cost nothing.
 */
export function countSpendOf(
  db: Db,
  accountId: string,
  reviewId: string,
  costUsd: number,
  now: Date,
): BatchItem<"sqlite"> | undefined {
  const micro = Math.round(costUsd * MICRO_USD);
  if (!(micro > 0) || !Number.isSafeInteger(micro)) return undefined;
  // In the table's column order: insert … select names every column.
  return db
    .insert(c)
    .select(sql`SELECT ${accountId}, 'spend', ${utcDay(now)}, ${micro}, ${now.getTime()}
      WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ${reviewId} AND account_id = ${accountId})`)
    .onConflictDoUpdate({
      target: [c.accountId, c.kind, c.day],
      set: { n: sql`${c.n} + excluded.n` },
    });
}

/** What the account's reviews cost on now's UTC day and in its calendar month, in dollars. */
export async function spent(
  db: Db,
  accountId: string,
  now: Date,
): Promise<{ todayUsd: number; monthUsd: number }> {
  const today = utcDay(now);
  const days = await db
    .select({ day: c.day, n: c.n })
    .from(c)
    .where(and(eq(c.accountId, accountId), eq(c.kind, "spend"), gte(c.day, utcMonthStartDay(now))));
  const sum = (rows: typeof days) => rows.reduce((total, r) => total + Number(r.n), 0) / MICRO_USD;
  return { todayUsd: sum(days.filter((d) => d.day === today)), monthUsd: sum(days) };
}

/**
 * Whether the account a row names in `account` is under both of its spend
 * limits, its own or the defaults: a hosted job of an account at one would
 * spend past it, so it is not claimed.
 */
function spendLeft(account: AnyColumn | SQL, now: Date): SQL {
  const spentSince = (day: string) =>
    sql`(SELECT coalesce(sum(${c.n}), 0) FROM ${c} WHERE ${c.accountId} = ${account}
      AND ${c.kind} = 'spend' AND ${c.day} >= ${day})`;
  // A limit turned off passes: the comparison with NULL, an unset one, does not.
  const under = (spent: SQL, column: AnyColumn, fallback: number) => {
    const own = sql`(SELECT ${column} FROM ${budgets} WHERE ${budgets.accountId} = ${account})`;
    return sql`(${own} = ${LIMIT_OFF} OR ${spent} < coalesce(${own}, ${fallback}) * ${MICRO_USD})`;
  };
  return sql`${under(spentSince(utcDay(now)), budgets.dailyUsd, DEFAULT_SPEND_LIMITS.dailyUsd)}
    AND ${under(spentSince(utcMonthStartDay(now)), budgets.monthlyUsd, DEFAULT_SPEND_LIMITS.monthlyUsd)}`;
}

/** Whether the account may start hosted work now: gateway calls left for the day, and under its spend limits. */
export const mayStart = (account: AnyColumn | SQL, serviceDefault: number, now: Date): SQL =>
  sql`(${callsLeft(account, serviceDefault, now)}) AND (${spendLeft(account, now)})`;

/** Takes back one countOne, for an upload that turned out to be a retry. */
export function uncountOne(
  db: Db,
  accountId: string,
  kind: DailyKind,
  now: Date,
): Promise<unknown> {
  return db
    .update(c)
    .set({ n: sql`${c.n} - 1` })
    .where(and(eq(c.accountId, accountId), eq(c.kind, kind), eq(c.day, utcDay(now)), gt(c.n, 0)));
}

/**
 * The first UTC day whose shared findings still count: retention deletes a
 * review and its findings RETENTION_DAYS after the upload, so the findings
 * counted from here on are at least all those still stored.
 */
const findingsWindowStart = (now: Date, days: number): string =>
  utcDay(new Date(now.getTime() - days * DAY));

/** The account's shared findings uploaded since findingsWindowStart, as a subquery. */
export function findingsCounted(accountId: string, now: Date, days = DEFAULT_RETENTION_DAYS): SQL {
  return sql`(SELECT coalesce(sum(${c.n}), 0) FROM ${c}
    WHERE ${c.accountId} = ${accountId} AND ${c.kind} = 'findings'
      AND ${c.day} >= ${findingsWindowStart(now, days)})`;
}

/**
 * Adds the findings stored for a review to the account's count for now's
 * day, in the batch that stored them; none stored, nothing is written. The
 * count reads the review's own findings, at most MAX_FINDINGS.
 */
export function countFindingsOf(
  db: Db,
  accountId: string,
  reviewId: string,
  now: Date,
): BatchItem<"sqlite"> {
  // In the table's column order: insert … select names every column.
  return db
    .insert(c)
    .select(sql`SELECT ${accountId}, 'findings', ${utcDay(now)}, stored, ${now.getTime()}
      FROM (SELECT count(*) AS stored FROM findings WHERE review_id = ${reviewId})
      WHERE stored > 0`)
    .onConflictDoUpdate({
      target: [c.accountId, c.kind, c.day],
      set: { n: sql`${c.n} + excluded.n` },
    });
}

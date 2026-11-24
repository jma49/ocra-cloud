import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { countWhere, utcDayOf } from "./dialect.js";
import { gatewayCalls as t } from "./schema.js";

// What an account's model calls used and cost, from the gateway's ledger,
// summed in SQL by UTC day and model. Reached only through scoped().

/** One model's calls on one UTC day; input is the prompt's tokens neither read from nor written to the cache. */
export type LedgerRow = {
  day: string;
  provider: string;
  model: string;
  calls: number;
  failed: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** What the priced calls cost, in US dollars. */
  costUsd: number;
  /** Calls that used tokens of a model without a price, which costUsd leaves out. */
  unpriced: number;
};

const MICRO_USD = 1_000_000;

const sum = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)`;
const unpriced = countWhere(sql`${t.costMicroUsd} IS NULL AND ${t.tokensIn} + ${t.tokensOut} > 0`);

function within(accountId: string, from: Date, to?: Date) {
  return and(
    eq(t.accountId, accountId),
    gte(t.createdAt, from),
    to ? lt(t.createdAt, to) : undefined,
  );
}

/** The account's calls from `from` up to `to`, by UTC day and model, oldest day first. */
export async function ledger(
  db: Db,
  accountId: string,
  from: Date,
  to: Date,
): Promise<LedgerRow[]> {
  const day = utcDayOf(db, sql`${t.createdAt}`);
  const model = sql<string>`coalesce(${t.model}, '(unknown)')`;
  const rows = await db
    .select({
      day,
      provider: t.provider,
      model,
      calls: sql<number>`count(*)`,
      failed: countWhere(sql`${t.status} >= 400`),
      input: sum(sql`${t.tokensIn} - ${t.cacheRead} - ${t.cacheWrite5m} - ${t.cacheWrite1h}`),
      cacheWrite5m: sum(t.cacheWrite5m),
      cacheWrite1h: sum(t.cacheWrite1h),
      cacheRead: sum(t.cacheRead),
      output: sum(t.tokensOut),
      cost: sum(t.costMicroUsd),
      unpriced,
    })
    .from(t)
    .where(within(accountId, from, to))
    .groupBy(day, t.provider, model)
    .orderBy(day, t.provider, model);
  return rows.map(({ cost, ...r }) => ({
    day: r.day,
    provider: r.provider,
    model: r.model,
    calls: Number(r.calls),
    failed: Number(r.failed),
    input: Number(r.input),
    cacheWrite5m: Number(r.cacheWrite5m),
    cacheWrite1h: Number(r.cacheWrite1h),
    cacheRead: Number(r.cacheRead),
    output: Number(r.output),
    costUsd: Number(cost) / MICRO_USD,
    unpriced: Number(r.unpriced),
  }));
}

/**
 * What the account's calls cost on each UTC day from `from` on, a day with
 * nothing spent left out, and how many calls in that time were unpriced.
 */
export async function spendByDay(
  db: Db,
  accountId: string,
  from: Date,
): Promise<{ days: { day: string; usd: number }[]; unpriced: number }> {
  const day = utcDayOf(db, sql`${t.createdAt}`);
  const rows = await db
    .select({ day, cost: sum(t.costMicroUsd), unpriced })
    .from(t)
    .where(within(accountId, from))
    .groupBy(day)
    .orderBy(day);
  return {
    days: rows
      .filter((r) => Number(r.cost) > 0)
      .map((r) => ({ day: r.day, usd: Number(r.cost) / MICRO_USD })),
    unpriced: rows.reduce((n, r) => n + Number(r.unpriced), 0),
  };
}

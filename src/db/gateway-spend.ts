import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { changedRows, type Db } from "./client.js";
import { countWhere, utcDayOf } from "./dialect.js";
import { gatewayCalls } from "./schema.js";

// What the account's model calls through ocra Cloud cost, beside what the
// uploaded reviews report: reached through scoped(). A run's calls that an
// upload claims are in that review's own cost and counted only there.

/**
 * How long before a run's start its calls may lie: the upload's duration
 * is the review's, not the CLI's setup before it.
 */
const CLAIM_SLACK_MS = 2 * 60_000;

export function accountGatewaySpend(db: Db, accountId: string) {
  const t = gatewayCalls;
  const own = eq(t.accountId, accountId);
  return {
    /**
     * Marks the session's run calls of the review's run, which took
     * `durationMs` up to now, that no review claimed yet as the review's;
     * how many. A retried upload claims none twice.
     */
    async claim(
      sessionId: string,
      durationMs: number,
      reviewId: string,
      now = new Date(),
    ): Promise<number> {
      const since = new Date(now.getTime() - durationMs - CLAIM_SLACK_MS);
      const result = await db
        .update(t)
        .set({ reviewId })
        .where(
          and(
            own,
            eq(t.sessionId, sessionId),
            eq(t.origin, "run"),
            isNull(t.reviewId),
            gte(t.createdAt, since),
          ),
        );
      return changedRows(result);
    },
    /**
     * The cost since a time of the calls no uploaded review reports: ocra
     * Cloud's own (Ask ocra, Explain, review chat) and runs that uploaded no
     * review (fixes, failed runs). Calls with tokens but no price are counted apart.
     */
    async unclaimed(since: Date) {
      const where = and(own, gte(t.createdAt, since), isNull(t.reviewId));
      const day = utcDayOf(db, sql`${t.createdAt}`);
      const cost = sql<number>`coalesce(sum(${t.costUsd}), 0)`;
      const [[total], days] = await db.batch([
        db
          .select({
            costUsd: cost,
            calls: sql<number>`count(*)`,
            console: countWhere(sql`${t.origin} = 'console'`),
            unpriced: countWhere(sql`${t.costUsd} IS NULL AND ${t.tokensIn} + ${t.tokensOut} > 0`),
          })
          .from(t)
          .where(where),
        db
          .select({ day, costUsd: cost })
          .from(t)
          .where(and(where, sql`${t.costUsd} > 0`))
          .groupBy(day)
          .orderBy(day),
      ]);
      return {
        costUsd: Number(total?.costUsd ?? 0),
        calls: Number(total?.calls ?? 0),
        console: Number(total?.console ?? 0),
        unpriced: Number(total?.unpriced ?? 0),
        days: days.map((d) => ({ day: d.day, costUsd: Number(d.costUsd) })),
      };
    },
  };
}

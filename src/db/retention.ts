import { and, inArray, lt, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { errorName, logError } from "../log.js";
import { DAY, utcDay } from "../time.js";
import type { Db } from "./client.js";
import {
  accounts,
  auditEvents,
  automationRuns,
  closedPulls,
  deviceCodes,
  gatewayCalls,
  liveRuns,
  pullFlows,
  pullReviews,
  rateWindows,
  reviews,
  serviceCounters,
  sessions,
  usageCounters,
} from "./schema.js";

// What the data policy (web /privacy) promises: review records, live runs, gateway call
// records, merged and closed pull requests and their review flow, the daily counts and the audit log are deleted after
// RETENTION_DAYS; expired login codes and sessions go at once. Runs daily
// from the cron trigger.

export const RETENTION_DAYS = 90;
/** An automation's run is kept for a month: enough to see why a rule acted. */
export const AUTOMATION_RUN_DAYS = 30;

/**
 * Runs every delete, each on its own: one that fails is logged and the rest
 * still run. Throws at the end, naming the deletes that failed, so the cron
 * run shows as failed. Only our own message is logged, never the error's
 * text, which could quote a row.
 */
export async function enforceRetention(db: Db, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  // Account by account, so a delete finds its rows through the index that
  // starts with account_id instead of reading the whole table (audit C3).
  const ofEachAccount = (column: SQLiteColumn) =>
    inArray(column, db.select({ id: accounts.id }).from(accounts));
  const deletes: [string, () => Promise<unknown>][] = [
    // A review's findings go with it (foreign key cascade, by findings_review).
    [
      "reviews",
      () =>
        db
          .delete(reviews)
          .where(and(ofEachAccount(reviews.accountId), lt(reviews.createdAt, cutoff))),
    ],
    // A live run's events, grants and comments go with it (cascade).
    [
      "live_runs",
      () =>
        db
          .delete(liveRuns)
          .where(and(ofEachAccount(liveRuns.accountId), lt(liveRuns.updatedAt, cutoff))),
    ],
    [
      "gateway_calls",
      () =>
        db
          .delete(gatewayCalls)
          .where(and(ofEachAccount(gatewayCalls.accountId), lt(gatewayCalls.createdAt, cutoff))),
    ],
    [
      "audit_events",
      () =>
        db
          .delete(auditEvents)
          .where(and(ofEachAccount(auditEvents.accountId), lt(auditEvents.createdAt, cutoff))),
    ],
    [
      "closed_pulls",
      () =>
        db
          .delete(closedPulls)
          .where(and(ofEachAccount(closedPulls.accountId), lt(closedPulls.closedAt, cutoff))),
    ],
    [
      "pull_flows",
      () =>
        db
          .delete(pullFlows)
          .where(and(ofEachAccount(pullFlows.accountId), lt(pullFlows.seenAt, cutoff))),
    ],
    [
      "pull_reviews",
      () =>
        db
          .delete(pullReviews)
          .where(and(ofEachAccount(pullReviews.accountId), lt(pullReviews.submittedAt, cutoff))),
    ],
    [
      "automation_runs",
      () =>
        db
          .delete(automationRuns)
          .where(
            and(
              ofEachAccount(automationRuns.accountId),
              lt(automationRuns.createdAt, new Date(now.getTime() - AUTOMATION_RUN_DAYS * DAY)),
            ),
          ),
    ],
    // DEVICE_DAILY_CODES a day at most, so they are read whole.
    ["device_codes", () => db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now))],
    // Only today's counts are used, and some are per network: the rest go.
    [
      "service_counters",
      () => db.delete(serviceCounters).where(lt(serviceCounters.day, utcDay(now))),
    ],
    // A window lasts a minute or so; a day later it is long over.
    [
      "rate_windows",
      () => db.delete(rateWindows).where(lt(rateWindows.start, now.getTime() - DAY)),
    ],
    // A session ends with its last token: for the CLI, the refresh token
    // (the sessions_ends index).
    [
      "sessions",
      () =>
        db
          .delete(sessions)
          .where(
            sql`coalesce(${sessions.refreshExpiresAt}, ${sessions.expiresAt}) < ${now.getTime()}`,
          ),
    ],
    [
      "usage_counters",
      () =>
        db
          .delete(usageCounters)
          .where(
            and(
              ofEachAccount(usageCounters.accountId),
              inArray(usageCounters.kind, usageCounters.kind.enumValues),
              lt(usageCounters.day, utcDay(cutoff)),
            ),
          ),
    ],
  ];
  const failed: string[] = [];
  for (const [table, run] of deletes) {
    try {
      await run();
    } catch (e) {
      failed.push(table);
      logError("retention_failed", { table, error: errorName(e) });
    }
  }
  if (failed.length > 0) throw new Error(`retention failed for: ${failed.join(", ")}`);
}

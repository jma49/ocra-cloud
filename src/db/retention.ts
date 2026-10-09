import { and, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { DAY, utcDay } from "../time.js";
import {
  accounts,
  auditEvents,
  deviceCodes,
  gatewayCalls,
  reviews,
  serviceCounters,
  sessions,
  usageCounters,
} from "./schema.js";

// What the data policy (web /privacy) promises: review records, gateway call
// records, the daily counts and the audit log are deleted after
// RETENTION_DAYS; expired login codes and sessions go at once. Runs daily
// from the cron trigger.

export const RETENTION_DAYS = 90;

/**
 * Runs every delete, each on its own: one that fails is logged and the rest
 * still run. Throws at the end, naming the deletes that failed, so the cron
 * run shows as failed. Only our own message is logged, never the error's
 * text, which could quote a row.
 */
export async function enforceRetention(db: DrizzleD1Database, now = new Date()): Promise<void> {
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
    // DEVICE_DAILY_CODES a day at most, so they are read whole.
    ["device_codes", () => db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now))],
    // Only today's counts are used, and some are per network: the rest go.
    [
      "service_counters",
      () => db.delete(serviceCounters).where(lt(serviceCounters.day, utcDay(now))),
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
      console.error(
        `retention: deleting from ${table} failed (${e instanceof Error ? e.name : "unknown"})`,
      );
    }
  }
  if (failed.length > 0) throw new Error(`retention failed for: ${failed.join(", ")}`);
}

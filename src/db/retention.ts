import { lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { DAY } from "../time.js";
import { auditEvents, deviceCodes, gatewayCalls, reviews, sessions } from "./schema.js";

// What the data policy (web /privacy) promises: review records, gateway call
// records and the audit log are deleted after RETENTION_DAYS; expired login
// codes and sessions go at once. Runs daily from the cron trigger.

export const RETENTION_DAYS = 90;

/**
 * Runs every delete, each on its own: one that fails is logged and the rest
 * still run. Throws at the end, naming the deletes that failed, so the cron
 * run shows as failed. Only our own message is logged, never the error's
 * text, which could quote a row.
 */
export async function enforceRetention(db: DrizzleD1Database, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  const deletes: [string, () => Promise<unknown>][] = [
    // A review's findings go with it (foreign key cascade).
    ["reviews", () => db.delete(reviews).where(lt(reviews.createdAt, cutoff))],
    ["gateway_calls", () => db.delete(gatewayCalls).where(lt(gatewayCalls.createdAt, cutoff))],
    ["audit_events", () => db.delete(auditEvents).where(lt(auditEvents.createdAt, cutoff))],
    ["device_codes", () => db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now))],
    // A session ends with its last token: for the CLI, the refresh token.
    [
      "sessions",
      () =>
        db
          .delete(sessions)
          .where(
            sql`coalesce(${sessions.refreshExpiresAt}, ${sessions.expiresAt}) < ${now.getTime()}`,
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

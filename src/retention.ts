import { lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { auditEvents, deviceCodes, gatewayCalls, reviews, sessions } from "./db/schema.js";

// What the data policy (web /privacy) promises: review records, gateway call
// records and the audit log are deleted after RETENTION_DAYS; expired login
// codes and sessions go at once. Runs daily from the cron trigger.

const RETENTION_DAYS = 90;
const DAY = 86_400_000;

/** A `days` query clamped to 1..RETENTION_DAYS: older records are gone. */
export const clampDays = (v: string | undefined, fallback: number) =>
  Math.min(Math.max(Math.trunc(Number(v ?? fallback)) || fallback, 1), RETENTION_DAYS);

export async function enforceRetention(db: DrizzleD1Database, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  await db.delete(reviews).where(lt(reviews.createdAt, cutoff));
  await db.delete(gatewayCalls).where(lt(gatewayCalls.createdAt, cutoff));
  await db.delete(auditEvents).where(lt(auditEvents.createdAt, cutoff));
  await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now));
  // A session ends with its last token: for the CLI, the refresh token.
  await db
    .delete(sessions)
    .where(sql`coalesce(${sessions.refreshExpiresAt}, ${sessions.expiresAt}) < ${now.getTime()}`);
}

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { utcDay } from "../time.js";
import { deviceCodes, serviceCounters } from "./schema.js";

// Device codes are found by their codes before any account is known; only
// the routes in ../device.ts use these.

export type DeviceCode = typeof deviceCodes.$inferSelect;

/**
 * Stores a new code unless the whole service already made dailyCap today;
 * returns whether it did. Anyone may ask for a code, so this cap, not one
 * per account, keeps a flood of requests from many addresses within the
 * Free plan's daily D1 writes (audit C1); a refusal writes nothing.
 * Expired codes are left to the daily retention run.
 */
export async function createDeviceCode(
  db: DrizzleD1Database,
  row: Pick<DeviceCode, "deviceCodeHash" | "userCode" | "label" | "expiresAt">,
  dailyCap: number,
  now = new Date(),
): Promise<boolean> {
  const c = serviceCounters;
  if (!(dailyCap >= 1)) return false;
  const counted = await db
    .insert(c)
    .values({ name: "device_codes", day: utcDay(now), n: 1 })
    .onConflictDoUpdate({
      target: [c.name, c.day],
      set: { n: sql`${c.n} + 1` },
      setWhere: sql`${c.n} < ${dailyCap}`,
    })
    .returning({ n: c.n });
  if (counted.length === 0) return false;
  await db.insert(deviceCodes).values({ id: crypto.randomUUID(), ...row });
  return true;
}

export function byUserCode(db: DrizzleD1Database, userCode: string) {
  return db.select().from(deviceCodes).where(eq(deviceCodes.userCode, userCode)).get();
}

export function byDeviceCodeHash(db: DrizzleD1Database, hash: string) {
  return db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hash)).get();
}

/** Moves a pending code to approved or denied; false if it was not pending. */
export async function decide(
  db: DrizzleD1Database,
  id: string,
  approve: boolean,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .update(deviceCodes)
    .set(approve ? { status: "approved", approvedAccountId: accountId } : { status: "denied" })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "pending")))
    .run();
  return result.meta.changes > 0;
}

export async function recordPoll(
  db: DrizzleD1Database,
  id: string,
  at: Date,
  intervalSeconds: number,
): Promise<void> {
  await db
    .update(deviceCodes)
    .set({ lastPolledAt: at, intervalSeconds })
    .where(eq(deviceCodes.id, id));
}

/** Marks an approved code used; false if another poll got there first. */
export async function consume(db: DrizzleD1Database, id: string): Promise<boolean> {
  const result = await db
    .update(deviceCodes)
    .set({ status: "consumed" })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "approved")))
    .run();
  return result.meta.changes > 0;
}

import { and, eq, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { deviceCodes } from "./schema.js";

// Device codes are found by their codes before any account is known; only
// the routes in ../device.ts use these.

export type DeviceCode = typeof deviceCodes.$inferSelect;

export async function createDeviceCode(
  db: DrizzleD1Database,
  row: Pick<DeviceCode, "deviceCodeHash" | "userCode" | "label" | "expiresAt">,
): Promise<void> {
  await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, new Date()));
  await db.insert(deviceCodes).values({ id: crypto.randomUUID(), ...row });
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

import { and, eq, sql } from "drizzle-orm";
import { utcDay } from "../time.js";
import { changedRows, type Db } from "./client.js";
import { deviceCodes, serviceCounters } from "./schema.js";

// Device codes are found by their codes before any account is known; only
// the routes in ../device.ts use these.

export type DeviceCode = typeof deviceCodes.$inferSelect;

/** The service's count of codes; a network's is this name and its key. */
const SERVICE = "device_codes";

/**
 * Stores a new code unless the network asking already had `perNetwork`
 * codes today, or the whole service `daily`; returns whether it did. Anyone
 * may ask for a code, so these caps, not one per account, keep a flood of
 * requests within the Free plan's daily D1 writes (audit C1), and the
 * network's own cap keeps one network from using up everyone's logins. A
 * refusal writes nothing, and a network's row is written only while the
 * service has room, so a day holds at most about `daily` of them. Expired
 * codes and past days' counts are left to the daily retention run.
 */
export async function createDeviceCode(
  db: Db,
  row: Pick<DeviceCode, "deviceCodeHash" | "userCode" | "label" | "expiresAt">,
  limits: { network: string; perNetwork: number; daily: number },
  now = new Date(),
): Promise<boolean> {
  const c = serviceCounters;
  const day = utcDay(now);
  if (!(limits.perNetwork >= 1 && limits.daily >= 1)) return false;
  const serviceHasRoom = sql`coalesce((SELECT ${c.n} FROM ${c}
    WHERE ${c.day} = ${day} AND ${c.name} = ${SERVICE}), 0) < ${limits.daily}`;
  // In the table's column order: insert … select names every column.
  const network = await db
    .insert(c)
    .select(sql`SELECT ${`${SERVICE}:${limits.network}`}, ${day}, 1 WHERE ${serviceHasRoom}`)
    .onConflictDoUpdate({
      target: [c.day, c.name],
      set: { n: sql`${c.n} + 1` },
      setWhere: sql`${c.n} < ${limits.perNetwork} AND ${serviceHasRoom}`,
    })
    .returning({ n: c.n });
  if (network.length === 0) return false;
  // A race for the service's last code can leave the network's count one
  // high: it refuses sooner, never later.
  const service = await db
    .insert(c)
    .values({ name: SERVICE, day, n: 1 })
    .onConflictDoUpdate({
      target: [c.day, c.name],
      set: { n: sql`${c.n} + 1` },
      setWhere: sql`${c.n} < ${limits.daily}`,
    })
    .returning({ n: c.n });
  if (service.length === 0) return false;
  await db.insert(deviceCodes).values({ id: crypto.randomUUID(), ...row });
  return true;
}

export function byUserCode(db: Db, userCode: string) {
  return db.select().from(deviceCodes).where(eq(deviceCodes.userCode, userCode)).get();
}

export function byDeviceCodeHash(db: Db, hash: string) {
  return db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, hash)).get();
}

/** Moves a pending code to approved or denied; false if it was not pending. */
export async function decide(
  db: Db,
  id: string,
  approve: boolean,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .update(deviceCodes)
    .set(approve ? { status: "approved", approvedAccountId: accountId } : { status: "denied" })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "pending")))
    .run();
  return changedRows(result) > 0;
}

export async function recordPoll(
  db: Db,
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
export async function consume(db: Db, id: string): Promise<boolean> {
  const result = await db
    .update(deviceCodes)
    .set({ status: "consumed" })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "approved")))
    .run();
  return changedRows(result) > 0;
}

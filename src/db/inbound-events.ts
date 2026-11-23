import { and, asc, eq, isNotNull, lte, notInArray } from "drizzle-orm";
import { changedRows, type Db, first } from "./client.js";
import { inboundEvents } from "./schema.js";

// The platforms' webhook deliveries (src/inbound/), shared by every
// account: one row per platform, host and delivery id, so the request that
// inserts it is the only one that acts on a delivery. Each attempt at its
// side effects is taken by one runner, a compare-and-set that moves
// attempts and retryAt (past its lease) together; the sweep takes the due
// one waiting longest of the repositories it has not tried yet.

export type InboundPlatform = (typeof inboundEvents.platform.enumValues)[number];

/** A delivery whose side effects this runner holds, at this attempt. */
export type ClaimedInbound = {
  id: string;
  platform: InboundPlatform;
  host: string;
  event: string;
  repo: string;
  attempts: number;
  work: unknown;
};

/**
 * Records a delivery, pending and held by the caller until leaseUntil;
 * false when the same one was recorded before.
 */
export async function receiveInbound(
  db: Db,
  row: Omit<ClaimedInbound, "attempts"> & { deliveryId: string; leaseUntil: Date },
): Promise<boolean> {
  const t = inboundEvents;
  const result = await db
    .insert(t)
    .values({
      id: row.id,
      platform: row.platform,
      host: row.host,
      deliveryId: row.deliveryId,
      event: row.event,
      repo: row.repo,
      state: "pending",
      attempts: 1,
      work: row.work,
      retryAt: row.leaseUntil,
    })
    .onConflictDoNothing({ target: [t.platform, t.host, t.deliveryId] });
  return changedRows(result) > 0;
}

/** Forgets a delivery whose answer failed, so that the platform's redelivery is taken. */
export async function forgetInbound(db: Db, id: string): Promise<void> {
  await db.delete(inboundEvents).where(eq(inboundEvents.id, id));
}

/** Replaces the first attempt's work, held until leaseUntil. */
export async function rearmInbound(db: Db, id: string, work: unknown, leaseUntil: Date) {
  const t = inboundEvents;
  await db
    .update(t)
    .set({ state: "pending", work, retryAt: leaseUntil })
    .where(and(eq(t.id, id), eq(t.attempts, 1)));
}

export type InboundOutcome =
  | { state: "done" | "failed" }
  | { state: "pending"; work: unknown; retryAt: Date };

/** Records how the attempt ended, only while it is still the one taken; the work goes unless a retry is due. */
export async function finishInbound(
  db: Db,
  id: string,
  attempts: number,
  outcome: InboundOutcome,
): Promise<boolean> {
  const t = inboundEvents;
  const result = await db
    .update(t)
    .set(
      outcome.state === "pending"
        ? { work: outcome.work, retryAt: outcome.retryAt }
        : { state: outcome.state, work: null, retryAt: null },
    )
    .where(and(eq(t.id, id), eq(t.attempts, attempts), eq(t.state, "pending")));
  return changedRows(result) > 0;
}

/** Takes the next attempt of the delivery due longest, of a repository not in skip; undefined when none is due. */
export async function claimInboundRetry(
  db: Db,
  now: Date,
  leaseMs: number,
  skip: readonly string[] = [],
): Promise<ClaimedInbound | undefined> {
  const t = inboundEvents;
  const due = await db
    .select({ id: t.id, attempts: t.attempts })
    .from(t)
    .where(
      and(
        isNotNull(t.retryAt),
        lte(t.retryAt, now),
        eq(t.state, "pending"),
        skip.length > 0 ? notInArray(t.repo, [...skip]) : undefined,
      ),
    )
    .orderBy(asc(t.retryAt))
    .limit(1)
    .then(first);
  if (!due) return undefined;
  return db
    .update(t)
    .set({ attempts: due.attempts + 1, retryAt: new Date(now.getTime() + leaseMs) })
    .where(and(eq(t.id, due.id), eq(t.state, "pending"), eq(t.attempts, due.attempts)))
    .returning({
      id: t.id,
      platform: t.platform,
      host: t.host,
      event: t.event,
      repo: t.repo,
      attempts: t.attempts,
      work: t.work,
    })
    .then(first);
}

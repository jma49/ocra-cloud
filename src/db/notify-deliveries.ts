import { and, asc, desc, eq, inArray, isNotNull, lte, notInArray } from "drizzle-orm";
import type {
  NotifyDeliveryError,
  NotifyDeliveryEvent,
  NotifyDeliveryState,
} from "../shared/index.js";
import { changedRows, type Db, first } from "./client.js";
import { notifyDeliveries } from "./schema.js";

// A channel's deliveries, of any kind (reached through scoped()): each attempt is
// taken by one sender, a compare-and-set that moves attempts and retryAt
// (past its lease) together, so that the request that made it and two
// retry sweeps never send it twice at once; and the sweep, across accounts,
// takes the due one waiting longest of the channels it has not tried yet.

export type AttemptResult = {
  state: NotifyDeliveryState;
  status: number | null;
  error: NotifyDeliveryError | null;
  latencyMs: number;
  retryAt: Date | null;
};

export function accountNotifyDeliveries(db: Db, accountId: string) {
  const d = notifyDeliveries;
  const own = eq(d.accountId, accountId);
  return {
    /** Records a delivery whose first attempt the caller makes now, leased until leaseUntil. */
    async start(row: {
      id: string;
      channelId: string;
      event: NotifyDeliveryEvent;
      payload: string;
      leaseUntil: Date;
    }): Promise<void> {
      await db.insert(d).values({
        id: row.id,
        accountId,
        channelId: row.channelId,
        event: row.event,
        payload: row.payload,
        attempts: 1,
        retryAt: row.leaseUntil,
      });
    },

    /** Records the attempt, only while it is still the one taken; the body goes unless a retry is due. */
    async finish(id: string, attempts: number, r: AttemptResult): Promise<boolean> {
      const res = await db
        .update(d)
        .set({
          state: r.state,
          status: r.status,
          error: r.error,
          latencyMs: r.latencyMs,
          retryAt: r.state === "pending" ? r.retryAt : null,
          ...(r.state === "pending" ? {} : { payload: null }),
        })
        .where(and(own, eq(d.id, id), eq(d.attempts, attempts), eq(d.state, "pending")));
      return changedRows(res) > 0;
    },

    /** The channel's newest deliveries. */
    recent(channelId: string, limit: number) {
      return db
        .select()
        .from(d)
        .where(and(own, eq(d.channelId, channelId)))
        .orderBy(desc(d.createdAt), desc(d.id))
        .limit(limit);
    },

    /**
     * Deletes the channel's deliveries past its newest keep, pending ones
     * too: an endpoint that keeps failing must not pile up bodies and
     * retries without bound.
     */
    async prune(channelId: string, keep: number): Promise<void> {
      const newest = db
        .select({ id: d.id })
        .from(d)
        .where(and(own, eq(d.channelId, channelId)))
        .orderBy(desc(d.createdAt), desc(d.id))
        .limit(keep);
      await db.delete(d).where(and(own, eq(d.channelId, channelId), notInArray(d.id, newest)));
    },

    /** Gives up the channel's pending deliveries: it was removed or its address changed. */
    async drop(channelIds: string[]): Promise<void> {
      if (channelIds.length === 0) return;
      await db.delete(d).where(and(own, inArray(d.channelId, channelIds)));
    },
  };
}

export type ClaimedDelivery = {
  id: string;
  accountId: string;
  channelId: string;
  event: NotifyDeliveryEvent;
  payload: string;
  attempts: number;
};

/**
 * Takes the next attempt of the delivery due longest, of a channel not in
 * skip, or undefined when none is due.
 */
export async function claimDeliveryRetry(
  db: Db,
  now: Date,
  leaseMs: number,
  skip: readonly string[] = [],
): Promise<ClaimedDelivery | undefined> {
  const d = notifyDeliveries;
  const due = await db
    .select({ id: d.id, attempts: d.attempts })
    .from(d)
    .where(
      and(
        eq(d.state, "pending"),
        isNotNull(d.retryAt),
        lte(d.retryAt, now),
        skip.length > 0 ? notInArray(d.channelId, [...skip]) : undefined,
      ),
    )
    .orderBy(asc(d.retryAt))
    .limit(1)
    .then(first);
  if (!due) return undefined;
  const claimed = await db
    .update(d)
    .set({ attempts: due.attempts + 1, retryAt: new Date(now.getTime() + leaseMs) })
    .where(and(eq(d.id, due.id), eq(d.state, "pending"), eq(d.attempts, due.attempts)))
    .returning({
      id: d.id,
      accountId: d.accountId,
      channelId: d.channelId,
      event: d.event,
      payload: d.payload,
      attempts: d.attempts,
    })
    .then(first);
  if (!claimed) return undefined;
  if (claimed.payload === null) return undefined;
  return { ...claimed, payload: claimed.payload };
}

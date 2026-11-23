import { type CallBudget, item, uncapped } from "../calls.js";
import type { Db } from "../db/client.js";
import { type AttemptResult, claimDeliveryRetry } from "../db/notify-deliveries.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { NotifyDeliveryError, NotifyDeliveryEvent } from "../shared/index.js";

// Every channel's deliveries, whatever its kind: one row per message or
// webhook event, its id the same on every attempt. An attempt the channel's
// kind calls transient (no answer, a 408, 429 or 5xx, an SMTP 4xx, a chat's
// rate limit) is tried again after its backoff until MAX_ATTEMPTS, by the
// retry sweep (retryDeliveries); a permanent one is given up at once. The
// body is kept only until then, and a channel keeps only its newest
// KEPT_DELIVERIES, pending or not. A body, an address or what came back is
// never logged; a failed write to the log is logged by its error's name only.

/** How one attempt went: error null when it was taken. */
export type Outcome = {
  status: number | null;
  error: NotifyDeliveryError | null;
  /** Whether a later attempt may go otherwise. */
  transient: boolean;
};

export const DELIVERED = (status: number | null): Outcome => ({
  status,
  error: null,
  transient: false,
});
export const REFUSED: Outcome = { status: null, error: "refused", transient: false };

/** What an attempt sends: the delivery's id and body, the address added by the channel's kind. */
type Delivery = { id: string; event: NotifyDeliveryEvent; payload: string };
/** Makes one attempt; never throws. */
export type Attempt = (delivery: Delivery, now: Date) => Promise<Outcome>;

/** Attempts in all, the first included. */
const MAX_ATTEMPTS = 5;
/** How long after a failed attempt (the first, second, ...) the next one is due. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** A sender that dies mid-attempt leaves the delivery to the sweep after this. */
const LEASE_MS = 2 * 60_000;
/** Deliveries a channel keeps, newest first. */
export const KEPT_DELIVERIES = 20;
/** Deliveries one sweep tries; the rest wait for the next. */
const PER_SWEEP = 50;

const REFUSED_RESULT: AttemptResult = {
  ...REFUSED,
  latencyMs: 0,
  state: "failed",
  retryAt: null,
};

async function attemptOnce(
  attempt: Attempt,
  delivery: Delivery,
  attempts: number,
  now: Date,
): Promise<AttemptResult> {
  const started = Date.now();
  const o = await attempt(delivery, now);
  const latencyMs = Date.now() - started;
  const base = { status: o.status, error: o.error, latencyMs };
  if (o.error === null) return { ...base, state: "delivered", retryAt: null };
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (o.transient && attempts < MAX_ATTEMPTS && delay !== undefined) {
    return { ...base, state: "pending", retryAt: new Date(now.getTime() + delay) };
  }
  return { ...base, state: "failed", retryAt: null };
}

/** Runs a write to the delivery log; whether it went. Its failure is logged by kind only. */
async function record(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (e) {
    logError("delivery_record_failed", { error: errorName(e) });
    return false;
  }
}

/** A message for the queue: its event, and its body made once its id is known. */
export type Outgoing = { event: NotifyDeliveryEvent; payload: (id: string, at: Date) => string };

/** Records each as a delivery to the channel and makes its first attempt; whether every one was taken. */
export async function deliver(
  data: Scoped,
  channel: Row<"notifyChannels">,
  attempt: Attempt,
  outgoing: readonly Outgoing[],
): Promise<boolean> {
  let ok = true;
  for (const out of outgoing) {
    const id = crypto.randomUUID();
    const now = new Date();
    const delivery = { id, event: out.event, payload: out.payload(id, now) };
    const recorded = await record(() =>
      data.deliveries.start({
        ...delivery,
        channelId: channel.id,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      }),
    );
    // A delivery the database could not record still goes once, without a retry or a log row.
    const sent = await item(() => attemptOnce(attempt, delivery, 1, now));
    if (sent.cut) {
      // The run's calls ran out first: nothing went, and the retry sweep sends it.
      if (recorded) await record(() => data.deliveries.giveBack(id, 1, new Date()));
      ok = false;
      continue;
    }
    if (recorded) await record(() => data.deliveries.finish(id, 1, sent.value));
    ok &&= sent.value.state === "delivered";
  }
  await record(() => data.deliveries.prune(channel.id, KEPT_DELIVERIES));
  return ok;
}

/**
 * Tries the deliveries due again, while `calls` has room for one more; how
 * many it tried. It goes round the channels, one delivery each in turn, so
 * that one account's failing address cannot take a whole sweep from
 * everyone else's. attemptFor gives how the channel's kind is sent to, or
 * undefined when this host cannot send it (the delivery is given up as
 * refused). One the calls ran out before is given back, due again.
 */
export async function retryDeliveries(
  db: Db,
  attemptFor: (channel: Row<"notifyChannels">) => Promise<Attempt | undefined>,
  now = () => new Date(),
  calls: CallBudget = uncapped(),
): Promise<number> {
  let tried = 0;
  const round = new Set<string>();
  for (; tried < PER_SWEEP && calls.has(); tried++) {
    let due = await claimDeliveryRetry(db, now(), LEASE_MS, [...round]);
    if (!due && round.size > 0) {
      round.clear();
      due = await claimDeliveryRetry(db, now(), LEASE_MS);
    }
    if (!due) break;
    round.add(due.channelId);
    const data = scoped(db, due.accountId);
    const channel = await data.get("notifyChannels", due.channelId);
    const attempt = channel && (await attemptFor(channel));
    const sent = attempt
      ? await item(() => attemptOnce(attempt, due, due.attempts, now()))
      : ({ value: REFUSED_RESULT, cut: false } as const);
    if (sent.cut) {
      await data.deliveries.giveBack(due.id, due.attempts, now());
      break;
    }
    const result = sent.value;
    await data.deliveries.finish(due.id, due.attempts, result);
    if (channel && result.state !== "pending") {
      await data.update("notifyChannels", channel.id, {
        lastStatus: result.state === "delivered" ? "ok" : "failed",
        lastSentAt: now(),
      });
    }
  }
  return tried;
}

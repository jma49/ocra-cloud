import { hmacHex, randomToken } from "../crypto.js";
import type { Db } from "../db/client.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import type { AttemptResult } from "../db/webhook-deliveries.js";
import { claimWebhookRetry } from "../db/webhook-deliveries.js";
import { deadline } from "../deadline.js";
import { boundedBytes } from "../platforms/http.js";
import {
  WEBHOOK_VERSION,
  type WebhookData,
  type WebhookError,
  type WebhookEvent,
  type WebhookPayload,
} from "../shared/index.js";
import { webhookUrl } from "./webhook-url.js";

// A webhook channel's deliveries: one per event, its versioned JSON body
// signed with the channel's secret (HMAC-SHA256 over the timestamp, a dot
// and the body) and posted with its delivery id, never following a
// redirect, within TIMEOUT_MS, reading at most MAX_ANSWER of the answer. An
// attempt with no answer, a 408, 429 or 5xx is tried again after its
// backoff until MAX_ATTEMPTS, by the retry sweep (retryWebhooks); its body
// is kept only until then. What the endpoint answered is never stored or
// logged, only its status and how long it took.

/** A webhook event and its data, as a message carries it. */
export type HookEvent = { [E in WebhookEvent]: { event: E; data: WebhookData[E] } }[WebhookEvent];

/** How an attempt went: the endpoint's status, or why none came. */
type WebhookAttempt = { status: number } | { error: Exclude<WebhookError, "status"> };

/** Posts a signed body; the host's own (src/node/webhook-transport.ts) also checks what the name resolves to. */
export type WebhookPost = (
  url: URL,
  init: { headers: Record<string, string>; body: string },
) => Promise<WebhookAttempt>;

/** What a webhook channel's sealed address holds. */
export type WebhookTarget = { url: string; secret: string };

const TIMEOUT_MS = 10_000;
/** Bytes of an answer read before it is dropped. */
export const MAX_ANSWER = 4096;
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

export const newWebhookSecret = () => randomToken("ocra_whsec_");

/** The `ocra-signature` header of a body sent at timestamp (seconds since the epoch). */
export async function webhookSignature(secret: string, timestamp: number, body: string) {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** The host's fetch: no redirect followed, a bounded wait and a bounded read. */
export const fetchWebhook: WebhookPost = async (url, init) => {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: clock.signal,
    });
    await boundedBytes(res, MAX_ANSWER);
    if (res.status >= 300 && res.status < 400) return { error: "redirect" };
    return { status: res.status };
  } catch {
    return { error: clock.timedOut() ? "timeout" : "network" };
  } finally {
    clock.clear();
  }
};

const retryable = (a: WebhookAttempt) =>
  "error" in a
    ? a.error === "timeout" || a.error === "network"
    : a.status === 408 || a.status === 429 || a.status >= 500;

/** Makes one attempt of the delivery and says how it went, the next one's time included. */
async function attempt(
  post: WebhookPost,
  target: WebhookTarget,
  delivery: { id: string; event: WebhookEvent; payload: string },
  attempts: number,
  now = () => new Date(),
): Promise<AttemptResult> {
  const url = webhookUrl(target.url);
  if (!url) return { state: "failed", status: null, error: "refused", latencyMs: 0, retryAt: null };
  const timestamp = Math.floor(now().getTime() / 1000);
  const started = Date.now();
  const sent = await post(url, {
    headers: {
      "content-type": "application/json",
      "user-agent": `ocra-webhooks/${WEBHOOK_VERSION}`,
      "ocra-event": delivery.event,
      "ocra-delivery": delivery.id,
      "ocra-timestamp": String(timestamp),
      "ocra-signature": await webhookSignature(target.secret, timestamp, delivery.payload),
    },
    body: delivery.payload,
  });
  const latencyMs = Date.now() - started;
  const status = "status" in sent ? sent.status : null;
  const error = "error" in sent ? sent.error : sent.status >= 300 ? "status" : null;
  if (error === null) return { state: "delivered", status, error, latencyMs, retryAt: null };
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (retryable(sent) && attempts < MAX_ATTEMPTS && delay !== undefined) {
    return {
      state: "pending",
      status,
      error,
      latencyMs,
      retryAt: new Date(now().getTime() + delay),
    };
  }
  return { state: "failed", status, error, latencyMs, retryAt: null };
}

function payloadOf(id: string, hook: HookEvent, createdAt: Date): string {
  return JSON.stringify({
    version: WEBHOOK_VERSION,
    id,
    event: hook.event,
    createdAt: createdAt.toISOString(),
    data: hook.data,
  } satisfies WebhookPayload);
}

/** Delivers each event to the channel, one delivery each; whether every first attempt was taken. */
export async function deliverHooks(
  data: Scoped,
  post: WebhookPost,
  channel: Row<"notifyChannels">,
  target: WebhookTarget,
  hooks: readonly HookEvent[],
): Promise<boolean> {
  let ok = true;
  for (const hook of hooks) {
    const id = crypto.randomUUID();
    const now = new Date();
    const delivery = { id, event: hook.event, payload: payloadOf(id, hook, now) };
    await data.webhooks.start({
      ...delivery,
      channelId: channel.id,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
    });
    const result = await attempt(post, target, delivery, 1);
    await data.webhooks.finish(id, 1, result);
    ok &&= result.state === "delivered";
  }
  await data.webhooks.prune(channel.id, KEPT_DELIVERIES);
  return ok;
}

export type RetryOutbox = {
  post: WebhookPost;
  open: (channel: Row<"notifyChannels">) => Promise<WebhookTarget | undefined>;
};

/** Tries the deliveries due again; how many it tried. */
export async function retryWebhooks(db: Db, out: RetryOutbox, now = () => new Date()) {
  let tried = 0;
  for (; tried < PER_SWEEP; tried++) {
    const due = await claimWebhookRetry(db, now(), LEASE_MS);
    if (!due) break;
    const data = scoped(db, due.accountId);
    const channel = await data.get("notifyChannels", due.channelId);
    const target = channel?.kind === "webhook" ? await out.open(channel) : undefined;
    const result: AttemptResult =
      channel && target
        ? await attempt(out.post, target, due, due.attempts, now)
        : { state: "failed", status: null, error: "refused", latencyMs: 0, retryAt: null };
    await data.webhooks.finish(due.id, due.attempts, result);
    if (channel && result.state !== "pending") {
      await data.update("notifyChannels", channel.id, {
        lastStatus: result.state === "delivered" ? "ok" : "failed",
        lastSentAt: now(),
      });
    }
  }
  return tried;
}

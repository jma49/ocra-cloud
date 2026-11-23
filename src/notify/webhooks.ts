import { outboundFetch } from "../calls.js";
import { hmacHex, randomToken } from "../crypto.js";
import { deadline } from "../deadline.js";
import { boundedBytes } from "../platforms/http.js";
import {
  type NotifyDeliveryError,
  WEBHOOK_VERSION,
  type WebhookData,
  type WebhookEvent,
  type WebhookPayload,
} from "../shared/index.js";
import { type Attempt, DELIVERED, type Outgoing, REFUSED } from "./deliveries.js";
import { webhookUrl } from "./webhook-url.js";

// A webhook channel's deliveries: one per event, its versioned JSON body
// signed with the channel's secret (HMAC-SHA256 over the timestamp, a dot
// and the body) and posted with its delivery id, never following a
// redirect, within TIMEOUT_MS, reading at most MAX_ANSWER of the answer. An
// attempt with no answer, a 408, 429 or 5xx is transient: the queue
// (./deliveries.ts) tries it again. What the endpoint answered is never
// stored or logged, only its status and how long it took.

/** A webhook event and its data, as a message carries it. */
export type HookEvent = { [E in WebhookEvent]: { event: E; data: WebhookData[E] } }[WebhookEvent];

/** How an attempt went: the endpoint's status, or why none came. */
type WebhookAttempt =
  | { status: number }
  | { error: Exclude<NotifyDeliveryError, "status" | "rejected"> };

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

export const newWebhookSecret = () => randomToken("ocra_whsec_");

/** The `ocra-signature` header of a body sent at timestamp (seconds since the epoch). */
export async function webhookSignature(secret: string, timestamp: number, body: string) {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** The host's fetch: no redirect followed, a bounded wait and a bounded read. */
export const fetchWebhook: WebhookPost = async (url, init) => {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await outboundFetch(url, {
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

/** One attempt of a delivery to the endpoint, signed at now. */
export function webhookAttempt(post: WebhookPost, target: WebhookTarget): Attempt {
  return async (delivery, now) => {
    const url = webhookUrl(target.url);
    if (!url) return REFUSED;
    const timestamp = Math.floor(now.getTime() / 1000);
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
    if ("error" in sent) return { status: null, error: sent.error, transient: retryable(sent) };
    if (sent.status < 300) return DELIVERED(sent.status);
    return { status: sent.status, error: "status", transient: retryable(sent) };
  };
}

/** The queue's message of a webhook event: its versioned body, made with the delivery's id. */
export const hookOutgoing = (hook: HookEvent): Outgoing => ({
  event: hook.event,
  payload: (id, createdAt) =>
    JSON.stringify({
      version: WEBHOOK_VERSION,
      id,
      event: hook.event,
      createdAt: createdAt.toISOString(),
      data: hook.data,
    } satisfies WebhookPayload),
});

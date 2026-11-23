import type { WebhookEvent } from "./webhooks.js";

// A channel's deliveries, of every kind: what each carried and how its
// last attempt went, never the body sent or what came back
// (docs/self-hosting.md, Notifications).

/** A webhook event, or a message only people's channels take: the daily digest, the weekly report, the notices held in quiet hours, the account's spend nearing or at its limit. */
export type NotifyDeliveryEvent =
  | WebhookEvent
  | "digest"
  | "weekly_report"
  | "held_notices"
  | "spend_limit";

/** pending: a retry is due; delivered: taken; failed: given up. */
export const NOTIFY_DELIVERY_STATES = ["pending", "delivered", "failed"] as const;
export type NotifyDeliveryState = (typeof NOTIFY_DELIVERY_STATES)[number];

/**
 * Why the last attempt failed: refused (an address ocra will not use, or
 * none it can open), a redirect, no answer in time, no connection, an
 * answer that is not a success (`status` holds the HTTP status, or the
 * SMTP reply code for email), rejected (a chat answered success but
 * refused the message in its body), or unwanted (a retry the channel's
 * `when`, narrowed since, no longer takes; it is not sent).
 */
export const NOTIFY_DELIVERY_ERRORS = [
  "refused",
  "redirect",
  "timeout",
  "network",
  "status",
  "rejected",
  "unwanted",
] as const;
export type NotifyDeliveryError = (typeof NOTIFY_DELIVERY_ERRORS)[number];

/** One delivery, without its body. */
export type NotifyDeliveryView = {
  /** The same on every attempt; a webhook's `ocra-delivery` header. */
  id: string;
  event: NotifyDeliveryEvent;
  state: NotifyDeliveryState;
  attempts: number;
  /** The last attempt's HTTP status, or SMTP reply code; null when none came. */
  status: number | null;
  error: NotifyDeliveryError | null;
  /** How long the last attempt took. */
  latencyMs: number | null;
  /** When the next attempt is due, for a pending one. */
  retryAt: string | null;
  createdAt: string;
};

export type NotifyDeliveriesView = { deliveries: NotifyDeliveryView[] };

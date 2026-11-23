import type { NotifyEvent } from "./notifications.js";

// A webhook channel's deliveries: the versioned JSON body each event is
// posted as (how they went is ./deliveries.ts). A body carries
// counts, ids and links; finding titles only when the account shares
// findings, and never code (docs/self-hosting.md, Outgoing webhooks).

export const WEBHOOK_VERSION = 1;

/** review_completed: a review reached the channel's `when`; ping: the test event; automation_ran: a rule's notify action. */
export type WebhookEvent = NotifyEvent | "review_completed" | "automation_ran" | "ping";

export type WebhookPull = {
  platform: "github" | "gitlab";
  repo: string;
  number: number;
  /** The pull request's page in the console. */
  consoleUrl: string;
};

/** Only when the account shares findings. */
export type WebhookFinding = {
  severity: "critical" | "warning" | "suggestion";
  title: string;
  file: string;
};

type WebhookReview = {
  id: string;
  consoleUrl: string;
  verdict: string | null;
  complete: boolean;
  critical: number;
  warning: number;
  suggestion: number;
};

type WebhookWaitingPull = WebhookPull & {
  title: string | null;
  /** When it started waiting, ISO 8601. */
  waitingSince: string;
};

type WebhookAtRiskPull = WebhookPull & {
  title: string;
  target: "first_review" | "merge";
  state: "near" | "past";
  /** When the target is due, ISO 8601. */
  due: string;
};

/** What each event's `data` holds. */
export type WebhookData = {
  review_completed: {
    review: WebhookReview;
    pull: WebhookPull | null;
    findings?: WebhookFinding[];
  };
  review_waiting: { pulls: WebhookWaitingPull[] };
  pull_waiting: { pulls: WebhookWaitingPull[] };
  pull_at_risk: { pulls: WebhookAtRiskPull[] };
  automation_ran: { rule: string; pull: WebhookPull | null };
  ping: { message: string };
} & {
  [E in Exclude<NotifyEvent, "review_waiting" | "pull_waiting" | "pull_at_risk">]: {
    pull: WebhookPull;
    /** What happened, in ocra's words, naming at most the login of who did it; never a title or comment. */
    summary: string;
    /** review_blocking's critical findings, when the account shares them. */
    findings?: WebhookFinding[];
  };
};

/** The body of a delivery; the delivery id is also its `ocra-delivery` header. */
export type WebhookPayload<E extends WebhookEvent = WebhookEvent> = {
  version: typeof WEBHOOK_VERSION;
  id: string;
  event: E;
  /** When the event happened, ISO 8601; a retry keeps it. */
  createdAt: string;
  data: WebhookData[E];
};

/** A webhook channel's signing secret: answered once, when it is made. */
export type WebhookSecretView = { secret: string };

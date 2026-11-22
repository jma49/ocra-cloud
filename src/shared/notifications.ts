// Where the account is told about its reviews: a chat's incoming webhook or
// an email address, which reviews it hears about, whether it gets the daily
// digest and the weekly report, and which events of its own pull requests
// it hears about.

export const NOTIFY_KINDS = ["slack", "wecom", "email"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** blocking: a review with a critical finding; findings: one with any; every: all of them. */
export const NOTIFY_WHEN = ["blocking", "findings", "every"] as const;
export type NotifyWhen = (typeof NOTIFY_WHEN)[number];

/**
 * Events of an enrolled repository's pull requests that concern the
 * account's own platform user: a review asked of them; on a pull request
 * they wrote, a reviewer's review, its merge or close, failed pre-merge
 * checks, or ocra's review with a critical finding.
 */
export const NOTIFY_EVENTS = [
  "review_requested",
  "pull_reviewed",
  "pull_closed",
  "checks_failed",
  "review_blocking",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type NotifyChannelView = {
  id: string;
  kind: NotifyKind;
  name: string;
  when: NotifyWhen;
  /** The address's last four characters; the address itself is never answered. */
  last4: string;
  /** False for an email address until its owner opens the link sent to it; it gets nothing before. */
  confirmed: boolean;
  /** Whether it gets the daily digest of yesterday's reviews (UTC). */
  digest: boolean;
  /** Whether it gets the weekly report, at the account's report slot. */
  weekly: boolean;
  /** The events of the account's own pull requests it hears about; none unless set. */
  events: NotifyEvent[];
  /** How the last message went; null before the first. */
  lastStatus: "ok" | "failed" | null;
  lastSentAt: string | null;
  createdAt: string;
};

export type NotifyChannelsView = {
  channels: NotifyChannelView[];
  /** Whether this server can send email; a server without it refuses email channels. */
  email: boolean;
};

export type NotifyChannelAdded = {
  channel: NotifyChannelView;
  /** For an email address: whether the confirmation link was sent. */
  confirmationSent?: boolean;
};

/** When the account's weekly report goes: a UTC weekday (0 is Sunday) and hour. */
export type ReportScheduleView = {
  weekday: number;
  hour: number;
  /** The next slot, ISO 8601; the report covers the seven days before it. */
  next: string;
};

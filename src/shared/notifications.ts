// Where the account is told about its reviews: a chat's incoming webhook or
// an email address, which reviews it hears about, whether it gets the daily
// digest and the weekly report, and which events of its own pull requests
// it hears about.

/** webhook: an HTTPS endpoint of the account's own, sent signed JSON (./webhooks.ts). */
export const NOTIFY_KINDS = ["slack", "wecom", "email", "webhook"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** blocking: a review with a critical finding; findings: one with any; every: all of them. */
export const NOTIFY_WHEN = ["blocking", "findings", "every"] as const;
export type NotifyWhen = (typeof NOTIFY_WHEN)[number];

/**
 * Events of an enrolled repository's pull requests that concern the
 * account's own platform user: a review asked of them; on a pull request
 * they wrote, a reviewer's review, its merge or close, failed checks
 * (ocra's pre-merge checks, or the repository's CI on its head), or ocra's
 * review with a critical finding; on one they set to
 * merge when ready, its merge or why it stopped; a stack merge they
 * started, its end or where it stopped (stack_merge, on any repository:
 * the merge is theirs, enrolled or not). Two are reminders, sent
 * by the hourly run once a pull request has waited the channel's
 * reminderHours: a review asked of them still not given (review_waiting),
 * and a pull request they wrote that no one has reviewed (pull_waiting).
 * Three are of the conversation: someone else commented on a pull request
 * they wrote (pull_commented), @-mentioned their login in a pull request's
 * comment or review (mentioned), or replied in a review thread they started
 * (thread_replied; only threads started since ocra began keeping them).
 * One is of the team: a pull request of an enrolled repository near or past
 * a review target (pull_at_risk), sent by the hourly run once per pull
 * request and target.
 */
export const NOTIFY_EVENTS = [
  "review_requested",
  "pull_reviewed",
  "pull_closed",
  "checks_failed",
  "review_blocking",
  "merge_when_ready",
  "stack_merge",
  "review_waiting",
  "pull_waiting",
  "pull_commented",
  "mentioned",
  "thread_replied",
  "pull_at_risk",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** The events that are reminders, which go only with reminderHours set. */
export const REMINDER_EVENTS = ["review_waiting", "pull_waiting"] as const satisfies NotifyEvent[];

/** The events a channel's quiet hours hold back: one that arrives in them goes in one message when they end. */
export const QUIET_EVENTS = [
  "pull_commented",
  "mentioned",
  "thread_replied",
  "pull_at_risk",
] as const satisfies NotifyEvent[];

/** After how many hours of waiting a channel is reminded. */
export const REMINDER_HOURS = [4, 8, 24, 48] as const;
export type ReminderHours = (typeof REMINDER_HOURS)[number];

/** Hours of the day (0-23, in the account's time zone) no reminder or comment notice goes: from start up to end, over midnight when end is earlier. */
export type QuietHours = { start: number; end: number };

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
  /** After how many hours its reminders go; null: none go. */
  reminderHours: ReminderHours | null;
  /** When its reminders wait for, and its comment notices are held until; null: any hour. */
  quietHours: QuietHours | null;
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
  /** For a webhook: the secret its deliveries are signed with, answered only here. */
  secret?: string;
};

/** When the account's weekly report goes: a UTC weekday (0 is Sunday) and hour. */
export type ReportScheduleView = {
  weekday: number;
  hour: number;
  /** The next slot, ISO 8601; the report covers the seven days before it. */
  next: string;
};

/** The account's IANA time zone, which quiet hours are read in. */
export type NotifyTimeZoneView = { timeZone: string };

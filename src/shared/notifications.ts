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
 * checks, or ocra's review with a critical finding; on one they set to
 * merge when ready, its merge or why it stopped. Two are reminders, sent
 * by the hourly run once a pull request has waited the channel's
 * reminderHours: a review asked of them still not given (review_waiting),
 * and a pull request they wrote that no one has reviewed (pull_waiting).
 */
export const NOTIFY_EVENTS = [
  "review_requested",
  "pull_reviewed",
  "pull_closed",
  "checks_failed",
  "review_blocking",
  "merge_when_ready",
  "review_waiting",
  "pull_waiting",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** After how many hours of waiting a channel is reminded. */
export const REMINDER_HOURS = [4, 8, 24, 48] as const;
export type ReminderHours = (typeof REMINDER_HOURS)[number];

/** Hours of the day (0-23, in the account's time zone) no reminder goes: from start up to end, over midnight when end is earlier. */
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
  /** When its reminders wait for; null: any hour. */
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

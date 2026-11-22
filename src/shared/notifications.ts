// Where the account is told about its reviews: a chat's incoming webhook or
// an email address, which reviews it hears about, and whether it gets the
// daily digest.

export const NOTIFY_KINDS = ["slack", "wecom", "email"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** blocking: a review with a critical finding; findings: one with any; every: all of them. */
export const NOTIFY_WHEN = ["blocking", "findings", "every"] as const;
export type NotifyWhen = (typeof NOTIFY_WHEN)[number];

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

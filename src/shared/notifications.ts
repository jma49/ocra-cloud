// Where the account is told about its reviews: a chat's incoming webhook,
// and which reviews it hears about.

export const NOTIFY_KINDS = ["slack", "wecom"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** blocking: a review with a critical finding; findings: one with any; every: all of them. */
export const NOTIFY_WHEN = ["blocking", "findings", "every"] as const;
export type NotifyWhen = (typeof NOTIFY_WHEN)[number];

export type NotifyChannelView = {
  id: string;
  kind: NotifyKind;
  name: string;
  when: NotifyWhen;
  /** The webhook address's last four characters; the address itself is never answered. */
  last4: string;
  /** How the last message went; null before the first. */
  lastStatus: "ok" | "failed" | null;
  lastSentAt: string | null;
  createdAt: string;
};

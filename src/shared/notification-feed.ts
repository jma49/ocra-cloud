import type { NotifyEvent } from "./notifications.js";

// The console's notification centre: the notices the account's own user is
// the one told of, kept whether or not it has channels, each with a read mark.

/**
 * The events of the account's own pull requests it is told of (see
 * NOTIFY_EVENTS), and three of its own: review_finished, ocra's review of
 * a pull request stored; automation, a rule's notify action ran;
 * job_failed, a hosted job (a review, an answer, a draft, a learning run)
 * gave up. The reminders and pull_at_risk are not kept: they follow a
 * channel's settings.
 */
export const FEED_KINDS = [
  "review_requested",
  "pull_reviewed",
  "pull_closed",
  "checks_failed",
  "review_blocking",
  "merge_when_ready",
  "stack_merge",
  "pull_commented",
  "mentioned",
  "thread_replied",
  "review_finished",
  "automation",
  "job_failed",
] as const satisfies readonly (NotifyEvent | "review_finished" | "automation" | "job_failed")[];
export type FeedKind = (typeof FEED_KINDS)[number];

/** How many days a notice is kept. */
export const FEED_DAYS = 30;
/** The unread count stops here; the web shows more as this many. */
export const FEED_UNREAD_CAP = 100;
/** The most notices a page lists, and the most ids one read mark takes. */
export const FEED_PAGE = 50;

export type FeedItemView = {
  id: string;
  kind: FeedKind;
  /** ISO 8601. */
  at: string;
  read: boolean;
  /** Plain text: what happened. */
  title: string;
  /** Plain text: the pull request's title, finding titles when shared, or a short redacted excerpt of a comment. */
  subtitle?: string;
  /** The console path it opens. */
  link: string;
  /** The repository's path on its platform. */
  repo?: string;
  pull?: number;
};

export type FeedPageView = {
  items: FeedItemView[];
  /** Unread notices, at most FEED_UNREAD_CAP. */
  unread: number;
  /** The `before` of the next page; absent on the last. */
  next?: string;
};

export type FeedUnreadView = { unread: number };

import type { FlowSpread } from "./flow.js";

// Who carries the review work of the account's enrolled repositories, for
// the Insights page: from what their webhooks recorded, by platform login.

export type ReviewerLoad = {
  login: string;
  /** Reviews submitted in the window. */
  reviews: number;
  /** Reviews asked of them in the window (the latest ask per pull request). */
  asked: number;
  /** From an ask in the window to their first review after it, over the asks they answered. */
  toFirstReview: FlowSpread;
  /** Asks of them that still wait now, on open pull requests out of draft. */
  openRequests: number;
  /** Pull requests they opened in the window. */
  authored: number;
};

export type ReviewLoadWeek = {
  /** The UTC Monday, YYYY-MM-DD; the first week is cut at the window's start. */
  start: string;
  /** From an ask to the reviewer's first review after it, by the week of that review. */
  turnaround: FlowSpread;
  /** Pull requests out of draft that were in the week more than 24 hours without a first review. */
  waitingOver24h: number;
};

export type ReviewLoadView = {
  /** The enrolled repository asked for, or null for all of them. */
  repo: string | null;
  days: number;
  /** Most reviews first, then most open requests, then by login; at most 100. */
  reviewers: ReviewerLoad[];
  /** Oldest first. */
  weeks: ReviewLoadWeek[];
  /** True when the window held more than one reading counts: the newest are counted. */
  capped: boolean;
};

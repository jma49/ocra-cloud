import type { Spread } from "./cycles.js";

// How enrolled repositories' pull requests moved toward review, for the
// Insights page: recorded from the platforms' webhooks, so it starts when a
// repository is enrolled for auto review.

/** A spread and how many pull requests it is over. */
export type FlowSpread = Spread & { count: number };

export const FLOW_SIZES = ["xs", "s", "m", "l", "xl"] as const;
/** Lines added plus deleted: under 10, 100, 500, 1000, and the rest. */
export type FlowSize = (typeof FLOW_SIZES)[number];

export type InsightsFlowView = {
  /** The enrolled repository asked for, or null for all of them. */
  repo: string | null;
  days: number;
  /** UTC weeks from Monday, oldest first, the first one cut at the window's start. */
  weeks: { start: string; opened: number; merged: number }[];
  /** From ready for review (or opened) to the first review by someone else. */
  toFirstReview: FlowSpread;
  /** From ready for review (or opened) to the first approval. */
  toFirstApproval: FlowSpread;
  /** From the first approval to the merge. */
  approvalToMerge: FlowSpread;
  /** Open, out of draft and not yet reviewed, longest waiting first (at most 5). */
  waiting: {
    repo: string;
    number: number;
    title: string;
    author: string | null;
    waitingMs: number;
    reviewRequested: boolean;
  }[];
  /** Reviews submitted in the window, per reviewer, most first. */
  reviewers: { login: string; reviews: number; approvals: number; pulls: number }[];
  /** Pull requests opened in the window by size; unknown where the platform does not say (GitLab). */
  sizes: Record<FlowSize | "unknown", number>;
  /** True when the window held more than one reading counts: the newest are counted. */
  capped: boolean;
};

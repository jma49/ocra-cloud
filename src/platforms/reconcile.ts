// What the daily reconciliation (src/reconcile.ts) reads of an enrolled
// repository: its pull requests as the platform has them now, so a close,
// an open state, an ask of a review or a review a webhook missed is filled
// in. Read as the bot or the
// enrolling account's link; nothing is written to the platform. A reader
// checks the run's budget before each call, which counts it as it goes out
// (src/calls.ts), and answers `spent` without calling when none is left.

import type { CallBudget } from "../calls.js";

/** One page of a listing: as many as the platform answers in one call. */
export const RECONCILE_PER_PAGE = 100;

type PullState = "open" | "closed" | "merged";

export type ReconciledPull = {
  number: number;
  title: string;
  author: string | null;
  authorId: string | null;
  draft: boolean;
  state: PullState;
  openedAt: Date | null;
  updatedAt: Date | null;
  /** When it was merged, or closed; null while open. */
  closedAt: Date | null;
  /** Whose review it asks now, users and (on GitHub) teams, as a listing names them. */
  asks: ReconciledAsk[];
};

/** An ask of a review the platform shows: of a user, or of a team (its org/slug as name). */
export type ReconciledAsk = { team: boolean; id: string; name: string | null };

/** A review submitted (a GitLab approval), keyed as its webhook keeps it in pull_reviews. */
export type ReconciledReview = {
  reviewKey: string;
  reviewerId: string;
  reviewer: string;
  bot: boolean;
  approved: boolean;
  /** Null where the platform does not say (an approval on an older GitLab). */
  submittedAt: Date | null;
};

export type ReconcileListing = {
  pulls: ReconciledPull[];
  /** True when the page cap stopped the listing before its end. */
  more: boolean;
};

/** The budget ran out before the reader finished. */
export type Spent = "spent";

export interface RepoReconcile {
  /** The repository's path now, read by the platform's id; null when the platform failed or refused. */
  name(token: string, platformRepoId: string, calls: CallBudget): Promise<string | Spent | null>;
  /** Closed or merged, changed since, newest change first, at most `pages` pages; null when the platform failed or refused. */
  closedSince(
    token: string,
    fullName: string,
    since: Date,
    pages: number,
    calls: CallBudget,
  ): Promise<ReconcileListing | Spent | null>;
  /** Open now, at most `pages` pages; null when the platform failed or refused. */
  open(
    token: string,
    fullName: string,
    pages: number,
    calls: CallBudget,
  ): Promise<ReconcileListing | Spent | null>;
  /** One pull request; `missing` when the platform has none of that number, null when it failed or refused. */
  one(
    token: string,
    fullName: string,
    number: number,
    calls: CallBudget,
  ): Promise<ReconciledPull | "missing" | Spent | null>;
  /** The reviews submitted on an open pull request, at most one page; null when the platform failed or refused. */
  reviews(
    token: string,
    fullName: string,
    number: number,
    calls: CallBudget,
  ): Promise<ReconciledReview[] | Spent | null>;
}

/** A time the platform wrote, or null when it is missing or not one. */
export function timeOf(text: unknown): Date | null {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

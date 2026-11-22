import type { MergeMethod, PullActionOutcome } from "./pull-page.js";

// "Merge when ready" on a pull request: the platform's own auto-merge where
// the repository allows it (`native`), otherwise an intent the server keeps
// and merges as the user once the platform, the pre-merge checks and ocra's
// review of the head allow it (`server`).

export const MERGE_INTENT_MODES = ["native", "server"] as const;
type MergeIntentMode = (typeof MERGE_INTENT_MODES)[number];

/** `merging` while one runner holds the merge; the last four are where an intent ends. */
export const MERGE_INTENT_STATES = [
  "armed",
  "merging",
  "merged",
  "closed",
  "disarmed",
  "cancelled",
  "failed",
] as const;
export type MergeIntentState = (typeof MERGE_INTENT_STATES)[number];

/**
 * Why an intent is where it is: still waiting on the platform (required
 * checks, approvals, conflicts), on the pre-merge checks, or on a review
 * with a critical finding; or why it stopped.
 */
export const MERGE_INTENT_REASONS = [
  "waiting_platform",
  "waiting_checks",
  "checks_failed",
  "blocking_review",
  "head_moved",
  "refused",
  "no_token",
  "unreachable",
] as const;
export type MergeIntentReason = (typeof MERGE_INTENT_REASONS)[number];

export type MergeIntentView = {
  mode: MergeIntentMode;
  method: MergeMethod;
  /** The head it merges; a push moves it only when keepOnPush. */
  head: string;
  keepOnPush: boolean;
  state: MergeIntentState;
  reason: MergeIntentReason | null;
  /** The login of who armed it. */
  armedBy: string;
  armedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type MergeWhenReadyView = {
  /** The newest intent on the pull request; null when it was never armed. */
  intent: MergeIntentView | null;
  /** Whether this server can merge it itself when the platform's auto-merge is unavailable. */
  server: boolean;
};

/**
 * `unavailable`: the platform's auto-merge is off for the repository and
 * this server cannot stand in; `ready`: it can merge now, so the platform
 * will not arm it; `merging`: a merge of it is under way.
 */
export type MergeWhenReadyOutcome = PullActionOutcome | "unavailable" | "ready" | "merging";

export type MergeWhenReadyAnswer = {
  outcome: MergeWhenReadyOutcome;
  intent: MergeIntentView | null;
};

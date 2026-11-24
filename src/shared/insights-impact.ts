import type { FixedVia } from "./domain.js";
import type { FlowSpread } from "./flow.js";

// What ocra changed in the account's repositories, for the Insights page:
// from the reviews it uploaded of pull requests, the webhooks' records of
// the enrolled repositories' pull requests and what the console recorded
// of the findings. Nothing is read from the platforms.

type ImpactFindings = { critical: number; warning: number; suggestion: number };

/**
 * What became of the findings of the reviews counted, as the console
 * recorded it. Null while the account does not share findings: none are kept.
 */
type ImpactActedOn = {
  /** Marked fixed: its fix committed from the console, or marked by hand. */
  fixed: number;
  /** The fixed ones by how they became fixed (FIXED_VIA); unknown for one fixed before that was kept. */
  fixedVia: Record<FixedVia | "unknown", number>;
  dismissed: number;
  /** Its comment's thread resolved by a person, on the platform or from the console, and not decided since. */
  addressed: number;
  /** Its pull request merged with it still open, and no fix seen. */
  merged: number;
  /** None of the above. */
  open: number;
  /** An issue was opened from it. */
  issueOpened: number;
  /** Its comment's thread resolved, from the console or on the platform, whatever its status. */
  threadResolved: number;
};

export type ImpactCounts = {
  /**
   * Pull requests: in an enrolled repository, those opened in the period
   * (the webhooks' records); in any other, those ocra reviewed in the
   * period, counted in the week of its first review in it.
   */
  pulls: number;
  /** Of those, the ones ocra reviewed: all of them in a repository not enrolled. */
  reviewedPulls: number;
  /** ocra's reviews of pull requests made in the period, in any repository. */
  reviews: number;
  /** What those reviews found, by severity. */
  findings: ImpactFindings;
  /** Earlier findings those reviews no longer found in the code, as the CLI counted them. */
  fixedOnRereview: number;
  /** Earlier findings a reviewer dismissed, as those reviews counted them. */
  dismissedOnRereview: number;
  actedOn: ImpactActedOn | null;
};

export type InsightsImpactView = {
  /** The repository asked for, enrolled or reviewed in the period, or null for all of them. */
  repo: string | null;
  days: number;
  /** Whether the account shares findings, so that actedOn is counted. */
  sharesFindings: boolean;
  total: ImpactCounts;
  /** UTC weeks from Monday, oldest first, the first one cut at the window's start. */
  weeks: ({ start: string } & ImpactCounts)[];
  /**
   * Per repository with a pull request or review in the window, most reviews
   * first. `enrolled`: its pull requests are the webhooks' records (see
   * ImpactCounts.pulls), and its merges are timed in toMerge.
   */
  repos: ({ repo: string; enrolled: boolean } & ImpactCounts)[];
  /**
   * Enrolled repositories' pull requests merged in the window; null when
   * none is in scope, since only the webhooks record merges.
   */
  toMerge: {
    /** From ocra's first review to the merge, of those it reviewed before. */
    fromReview: FlowSpread;
    /** From opened to the merge, of those ocra reviewed before. */
    reviewed: FlowSpread;
    /** From opened to the merge, of those it did not. */
    unreviewed: FlowSpread;
  } | null;
  /** True when the window held more than one reading counts: the newest are counted. */
  capped: boolean;
};

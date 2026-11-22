import type { FixedVia } from "./domain.js";
import type { FlowSpread } from "./flow.js";

// What ocra changed in the account's enrolled repositories, for the Insights
// page: from the reviews it uploaded of their pull requests, the webhooks'
// records of those pull requests and what the console recorded of the
// findings. Nothing is read from the platforms.

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
  /** Neither fixed nor dismissed. */
  open: number;
  /** An issue was opened from it. */
  issueOpened: number;
  /** Its comment's thread resolved from the console, whatever its status. */
  threadResolved: number;
};

export type ImpactCounts = {
  /** Pull requests opened in the period, from the webhooks' records. */
  pulls: number;
  /** Of those, the ones ocra reviewed. */
  reviewedPulls: number;
  /** ocra's reviews of the enrolled repositories' pull requests made in the period. */
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
  /** The enrolled repository asked for, or null for all of them. */
  repo: string | null;
  days: number;
  /** Whether the account shares findings, so that actedOn is counted. */
  sharesFindings: boolean;
  total: ImpactCounts;
  /** UTC weeks from Monday, oldest first, the first one cut at the window's start. */
  weeks: ({ start: string } & ImpactCounts)[];
  /** Per enrolled repository with a pull request or review in the window, most reviews first. */
  repos: ({ repo: string } & ImpactCounts)[];
  /** Pull requests merged in the window. */
  toMerge: {
    /** From ocra's first review to the merge, of those it reviewed before. */
    fromReview: FlowSpread;
    /** From opened to the merge, of those ocra reviewed before. */
    reviewed: FlowSpread;
    /** From opened to the merge, of those it did not. */
    unreviewed: FlowSpread;
  };
  /** True when the window held more than one reading counts: the newest are counted. */
  capped: boolean;
};

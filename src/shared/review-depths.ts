import type { ReviewDepth, Severity } from "@open-cr-agent/cloud-contract";

// How thorough a hosted review is: the engine's depth (--depth), plus the
// settings the server holds the review to whatever the account's are,
// written into the review's configuration file. A repository has one; a
// review asked for on a pull request's page may choose another.

export type { ReviewDepth };
/** The contract's REVIEW_DEPTHS, which the web cannot import as a value (test-node/review-depths.test.ts). */
export const REVIEW_DEPTHS = [
  "quick",
  "standard",
  "deep",
] as const satisfies readonly ReviewDepth[];

/** Today's hosted review: the engine's own defaults, nothing set. */
export const DEFAULT_REVIEW_DEPTH: ReviewDepth = "standard";

/** The engine settings a depth sets; a key left out is the engine's or the account's. */
export type ReviewDepthSettings = {
  /** Reviewers turned off, by the engine's ids. */
  reviewersOff?: readonly string[];
  /** The engine's showPreExisting: findings on lines the change did not touch. */
  showPreExisting?: boolean;
  /** The engine's minInlineSeverity: findings below it are listed in the summary, not posted inline. */
  minInlineSeverity?: Severity;
  /** The engine's maxInlineComments: the most findings posted inline; the rest are listed in the summary. */
  maxInlineComments?: number;
  /**
   * The engine's ultra: every reviewer at every tier, two samples each, about
   * twice the cost. true adds --ultra; false, in the configuration file, turns
   * off an ultra the account's settings turn on.
   */
  ultra?: boolean;
};

export const REVIEW_DEPTH_SETTINGS: Record<ReviewDepth, ReviewDepthSettings> = {
  // Ten inline comments is about what one pass over a pull request reads; the
  // findings held back stay in the summary and the report.
  quick: {
    reviewersOff: ["performance", "docs", "agents-md"],
    showPreExisting: false,
    minInlineSeverity: "warning",
    maxInlineComments: 10,
    ultra: false,
  },
  standard: {},
  deep: { ultra: true },
};

export type ReviewDepthView = { depth: ReviewDepth };

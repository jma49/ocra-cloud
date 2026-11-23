// How thorough a hosted review is, by the engine's depth names: a preset the
// server turns into settings the pinned engine already has, written into the
// review's configuration file (and, for one, a flag). A repository has one;
// a review asked for on a pull request's page may choose another.

export const REVIEW_DEPTHS = ["quick", "standard", "deep"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

/** Today's hosted review: the engine's own defaults, nothing set. */
export const DEFAULT_REVIEW_DEPTH: ReviewDepth = "standard";

/** The engine settings a depth sets; a key left out is the engine's or the account's. */
export type ReviewDepthSettings = {
  /** Reviewers turned off, by the engine's ids. */
  reviewersOff?: readonly string[];
  /** The engine's showPreExisting: findings on lines the change did not touch. */
  showPreExisting?: boolean;
  /** The engine's --ultra: every reviewer at every tier, two samples each, about twice the cost. */
  ultra?: true;
};

export const REVIEW_DEPTH_SETTINGS: Record<ReviewDepth, ReviewDepthSettings> = {
  quick: { reviewersOff: ["performance", "docs", "agents-md"], showPreExisting: false },
  standard: {},
  deep: { ultra: true },
};

export type ReviewDepthView = { depth: ReviewDepth };

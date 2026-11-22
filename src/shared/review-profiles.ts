// How much a hosted review of an enrolled repository says: a named preset
// the server turns into settings the pinned engine already has, written
// into the review's configuration file (and, for one, a flag). Nothing here
// is new engine behaviour; the engine has no severity floor or comment cap.

export const REVIEW_PROFILES = ["quiet", "balanced", "thorough"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

/** Today's hosted review: the engine's own defaults, nothing set. */
export const DEFAULT_REVIEW_PROFILE: ReviewProfile = "balanced";

/** The engine settings a profile sets; a key left out is the engine's or the account's. */
export type ReviewProfileSettings = {
  /** Reviewers turned off, by the engine's ids. */
  reviewersOff?: readonly string[];
  /** The engine's showPreExisting: findings on lines the change did not touch. */
  showPreExisting?: boolean;
  /** The engine's --ultra: every reviewer at every tier, two samples each, about twice the cost. */
  ultra?: true;
};

export const REVIEW_PROFILE_SETTINGS: Record<ReviewProfile, ReviewProfileSettings> = {
  quiet: { reviewersOff: ["performance", "docs", "agents-md"], showPreExisting: false },
  balanced: {},
  thorough: { ultra: true },
};

export type ReviewProfileView = { profile: ReviewProfile };

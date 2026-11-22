import type { CodePlatformKind } from "./domain.js";

// How long merged pull requests took, for the Insights page: the user's own,
// or every author's in one repository.

export type CyclePull = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string;
  mergedAt: string;
  firstReviewAt: string | null;
  /** Opened to first review by someone else; null without one. */
  toFirstReviewMs: number | null;
  toMergeMs: number;
};

/** Median and 90th percentile, null over no pull requests. */
export type Spread = { median: number | null; p90: number | null };

export type CycleView = {
  platform: CodePlatformKind;
  repo: string | null;
  days: number;
  pulls: CyclePull[];
  /** How many were merged without anyone else's review. */
  unreviewed: number;
  toFirstReview: Spread;
  toMerge: Spread;
  /** True when more merged than one reading holds: the newest are counted. */
  capped: boolean;
};

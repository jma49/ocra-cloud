import type { CodePlatformKind } from "./domain.js";

// Review targets of the account's enrolled repositories (an account default,
// and a repository's own in its place), and the open pull requests that are
// past one or near it, for the Insights page and pull_at_risk: read only
// from what the repositories' webhooks stored.

/** first_review: from ready for review to the first review; merge: from ready to merged. */
export type ReviewTargetKind = "first_review" | "merge";

export const MAX_FIRST_REVIEW_HOURS = 720;
export const MAX_MERGE_DAYS = 90;
/** A pull request is near a target once this share of it has passed. */
export const NEAR_TARGET = 0.75;

/** A null field sets no target of that kind. */
export type ReviewTargets = {
  /** Hours, 1 to MAX_FIRST_REVIEW_HOURS. */
  firstReviewHours: number | null;
  /** Days, 1 to MAX_MERGE_DAYS. */
  mergeDays: number | null;
};

type ReviewTargetsRepoView = {
  reviewRepoId: string;
  platform: CodePlatformKind;
  fullName: string;
  /** The repository's own targets, or null when it takes the account default. */
  targets: ReviewTargets | null;
};

export type ReviewTargetsView = {
  default: ReviewTargets;
  /** Every enrolled repository, by name. */
  repos: ReviewTargetsRepoView[];
};

export type AtRiskPullView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  target: ReviewTargetKind;
  /** past: its target went by; near: at least NEAR_TARGET of it has passed. */
  state: "past" | "near";
  /** When its clock started (ready for review, or reopened for first_review), ISO 8601. */
  since: string;
  /** When its target ends, ISO 8601. */
  due: string;
  /** Logins asked for a review that have not given one since, where the platform named them. */
  waitingOn: string[];
};

export type AtRiskView = {
  /** The enrolled repository asked for, or null for all of them. */
  repo: string | null;
  /** Past before near, then the earliest due first; at most 200. */
  pulls: AtRiskPullView[];
  /** Whether the account or any repository has a target set. */
  targetsSet: boolean;
  /** True when more open pull requests were stored than one reading takes: the oldest were read. */
  capped: boolean;
};

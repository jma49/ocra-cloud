import type { GenerateKind } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";
import type { ReviewProfile } from "./review-profiles.js";

// Pull requests reviewed by the server itself when they open or gain
// commits (ADR-0046): the repositories an account enrolled and their jobs.

export const REVIEW_JOB_STATES = ["queued", "running", "done", "failed", "superseded"] as const;
type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

/**
 * What a repository does with the findings people decline in their threads:
 * nothing, a pull request of learnings left for a person to merge, or one
 * that merges once its checks pass.
 */
export const LEARN_MODES = ["off", "propose", "merge"] as const;
export type LearnMode = (typeof LEARN_MODES)[number];
/** As the engine's `ocra learn --propose` does unless told to leave it to a person. */
export const DEFAULT_LEARN_MODE: LearnMode = "merge";

/** A queued job's error while it waits for the account's daily gateway calls to reset. */
export const DAILY_LIMIT_WAIT = "daily_limit";

export type AutoReviewRepoView = {
  id: string;
  platform: CodePlatformKind;
  host: string;
  fullName: string;
  profile: ReviewProfile;
  /** Whether pull requests are reviewed as they open or gain commits; off, only when a person asks. */
  automatic: boolean;
  learn: LearnMode;
  latest: {
    number: number;
    head: string;
    state: ReviewJobState;
    error: string | null;
    finishedAt: string | null;
  } | null;
};

/** What the automatic switch of an enrolled repository answers. */
export type AutoReviewSwitchView = { automatic: boolean };

/** What the learn setting of an enrolled repository answers. */
export type AutoReviewLearnView = { learn: LearnMode };

/** A pull request whose declined findings are being drafted into learnings, or were. */
export type LearnJobView = {
  number: number;
  state: ReviewJobState;
  error: string | null;
  /** When it last ended; null while it has not. */
  finishedAt: string | null;
};

export type { GenerateKind };

/** One request to generate, on the head it was asked for. */
export type GenerateJobView = {
  kind: GenerateKind;
  head: string;
  state: ReviewJobState;
  error: string | null;
  finishedAt: string | null;
};

/** A pull request's review asked for on the console, or the newest one the server ran. */
export type PullReviewJobView = {
  state: Exclude<ReviewJobState, "superseded">;
  jobId: string;
  head: string;
  queuedAt: string;
};

export type PullReviewNowView = { job: PullReviewJobView | null };

/**
 * The remote runners that asked this deployment for jobs lately, newest
 * first; `remote` is false where the server runs them itself.
 */
export type ReviewRunnersView = {
  remote: boolean;
  runners: { name: string; version: string; lastSeenAt: string }[];
};

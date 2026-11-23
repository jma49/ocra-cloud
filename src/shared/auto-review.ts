import type { GenerateKind } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";
import type { ReviewProfile } from "./review-profiles.js";

// Pull requests reviewed by the server itself when they open or gain
// commits (ADR-0046): the repositories an account enrolled and their jobs.

export const REVIEW_JOB_STATES = ["queued", "running", "done", "failed", "superseded"] as const;
type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

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
  /** Whether the account gave the GitLab project its own access token, never the token itself. */
  hasAccessToken: boolean;
  /** The username of that token's bot user; null without one. */
  accessTokenBot: string | null;
  latest: {
    number: number;
    head: string;
    state: ReviewJobState;
    error: string | null;
    finishedAt: string | null;
  } | null;
};

/** What setting or clearing an enrolled GitLab project's access token answers. */
export type RepoAccessTokenView = { hasAccessToken: boolean; accessTokenBot: string | null };

/** What the automatic switch of an enrolled repository answers. */
export type AutoReviewSwitchView = { automatic: boolean };

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

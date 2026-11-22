import type { GenerateKind } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";

// Pull requests reviewed by the server itself when they open or gain
// commits (ADR-0046): the repositories an account enrolled and their jobs.

export const REVIEW_JOB_STATES = ["queued", "running", "done", "failed", "superseded"] as const;
type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

export type AutoReviewRepoView = {
  id: string;
  platform: CodePlatformKind;
  host: string;
  fullName: string;
  latest: {
    number: number;
    head: string;
    state: ReviewJobState;
    error: string | null;
    finishedAt: string | null;
  } | null;
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

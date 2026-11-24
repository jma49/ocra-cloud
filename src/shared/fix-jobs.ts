import type { FixFailureCause, FixOutcome, FixReason } from "@open-cr-agent/cloud-contract";

// "Fix with ocra": a fix asked of `ocra fix` in the runner for a stored
// finding of a hosted review that came without one (ADR-0077). A proposed
// fix becomes the finding's own, which the pull request page commits as it
// does a review's (POST /api/pulls/apply-fix, /api/pulls/apply-batch).

/**
 * Fixes an account may ask for a UTC day. Each is a clone and a fixer model
 * call on the deployment's runner, which an account clicking through a pull
 * request's findings needs far fewer of; more would let one account hold the
 * shared runner's queue for hours. Its gateway calls also count against its
 * daily call limit.
 */
export const MAX_DAILY_FIX_REQUESTS = 50;

/** One request for a fix of a finding, at the head it was reviewed at. */
export type FixJobView = {
  id: string;
  finding: string;
  head: string;
  state: "queued" | "running" | "done" | "failed";
  /** What `ocra fix` answered; null until it did. */
  outcome: FixOutcome | null;
  /** Why no fix was proposed, as `ocra fix` says; null when one was, or before an answer. */
  reason: FixReason | null;
  /** What failed when the reason is `failed`; null otherwise, or from a run that gave none. */
  cause: FixFailureCause | null;
  /** Why the run failed, or the retry waits; null otherwise. */
  error: string | null;
  /** ISO 8601. */
  createdAt: string;
  finishedAt: string | null;
};

/**
 * What POST /api/auto-review/fixes answers (body `{ finding }`): `queued`,
 * or `requested` (a request was queued, running or answered already: `job`
 * is it); `has_fix`, the finding has a fix; `not_open`, it is fixed or
 * dismissed. A day's requests used up answer daily_limit.
 */
export type FixRequestView = {
  outcome: "queued" | "requested" | "has_fix" | "not_open";
  job: FixJobView | null;
};

/** GET /api/auto-review/fixes/finding/:id: the finding's request at its reviewed head. */
export type FindingFixView = { job: FixJobView | null };

/** GET /api/auto-review/fixes?platform&repo&number: the pull request's requests, newest first. */
export type PullFixJobsView = { enrolled: boolean; jobs: FixJobView[] };

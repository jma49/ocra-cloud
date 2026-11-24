import type { CodePlatformKind } from "./domain.js";
import type { PullSinceState } from "./pull-page.js";

/**
 * GET /api/pulls/review-changes: how far a pull request moved since ocra's
 * latest review of it, for "N new commits since the last review" and its
 * "Review changes" button, which asks POST /api/pulls/review-now (a hosted
 * review of a pull request reviews only what changed since the previous
 * one, unless it was rebased away).
 */
export type PullReviewChangesView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  /** ocra's latest review of the pull request; null when none was uploaded. */
  review: { id: string; head: string; at: string } | null;
  /** From the review's head to the current one, as GET /api/pulls/since says it. */
  state: PullSinceState;
  /** Commits from the review's head; null when the platform did not say or a rewrite left it out. */
  commits: number | null;
  /** Versions (pushes) after the review's head; null when the head is in none of them. */
  versions: number | null;
  /** The review's findings still open at its head. */
  openFindings: number;
  /** Whether the repository reviews every push itself; null when the account did not enroll it. */
  automatic: boolean | null;
  /**
   * Whether to offer "Review changes": an enrolled repository reviewed only
   * when asked, whose pull request moved since a review that left findings open.
   */
  reviewChanges: boolean;
};

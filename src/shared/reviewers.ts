import type { CodePlatformKind } from "./domain.js";
import type { PullActionOutcome } from "./pull-page.js";

// Reviewers suggested for a pull request: the changed files' code owners at
// its base, and who reviewed the enrolled repository's pull requests lately,
// those in the directories this one changes most.

/**
 * Why someone is suggested: they own changed files, reviewed here in the
 * last days, or reviewed pull requests changing the same directories.
 */
export type ReviewerReason = "codeowner" | "recent_reviewer" | "reviewed_these_paths";

/** A directory the pull request changes and how many pull requests changing it they reviewed. */
export type ReviewedPaths = { prefix: string; pulls: number };

export type SuggestedReviewer = {
  login: string;
  reasons: ReviewerReason[];
  /**
   * Higher first: owned files, recent reviews and reviews in the changed
   * directories add, open review requests take away.
   */
  score: number;
  /** Changed files the CODEOWNERS file gives them. */
  ownedFiles: number;
  /** Reviews they submitted on the repository within historyDays. */
  recentReviews: number;
  /**
   * The changed directory (top-level or second-level) in which they
   * reviewed the most of the repository's pull requests within
   * historyDays, as in "reviewed 4 pull requests in src/db"; null for none.
   */
  reviewedPaths: ReviewedPaths | null;
  /** Open pull requests asking them for a review now, as the user sees them; null when unread. */
  load: number | null;
  alreadyRequested: boolean;
};

export type CodeOwnerKind = "user" | "team" | "email" | "role";

/** An owner the CODEOWNERS file names for changed files; teams and roles are not expanded. */
export type CodeOwnerMatch = { owner: string; kind: CodeOwnerKind; files: number };

export type PullReviewersView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  suggestions: SuggestedReviewer[];
  owners: CodeOwnerMatch[];
  /** The CODEOWNERS file read at the base; read is false when it was too large or unreadable. */
  codeowners: { path: string; read: boolean } | null;
  /** `not_enrolled`: the repository's reviews are not kept, so only code owners are suggested. */
  history: "repository" | "not_enrolled";
  historyDays: number;
  /** True when the pull request has more changed files than were matched. */
  truncated: boolean;
};

export type RequestReviewersView = { outcome: PullActionOutcome };

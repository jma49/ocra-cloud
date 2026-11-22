import type { CodePlatformKind } from "./domain.js";
import type { PullActionOutcome } from "./pull-page.js";

// Reviewers suggested for a pull request: the changed files' code owners at
// its base, and who reviewed the enrolled repository's pull requests lately.

/** Why someone is suggested: they own changed files, or reviewed here in the last days. */
export type ReviewerReason = "codeowner" | "recent_reviewer";

export type SuggestedReviewer = {
  login: string;
  reasons: ReviewerReason[];
  /** Higher first: owned files and recent reviews add, open review requests take away. */
  score: number;
  /** Changed files the CODEOWNERS file gives them. */
  ownedFiles: number;
  /** Reviews they submitted on the repository within historyDays. */
  recentReviews: number;
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

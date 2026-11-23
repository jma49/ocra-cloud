import type { CodePlatformKind } from "./domain.js";

// Who a pull request asks for a review, how each answered, and who it is
// assigned to, read live as the signed-in user and changed as them; and the
// repository's people one can ask. Nothing read or sent is kept.

/** Logins one edit adds or removes, in each list. */
export const MAX_PEOPLE_EDITS = 10;
/** People one search answers. */
export const MAX_PEOPLE_CANDIDATES = 20;
/** The longest prefix a search takes: a GitLab username's length. */
export const MAX_PEOPLE_PREFIX = 255;

/**
 * Where a reviewer stands: asked and not answered since (`requested`), or
 * their latest review's verdict. A comment never hides an earlier verdict.
 */
export type ReviewerState =
  | "requested"
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";

export type PullReviewer = { login: string; state: ReviewerState };

/** A team asked for a review (GitHub only). */
export type PullTeamReviewer = { slug: string; name: string };

export type PullPeopleView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  /** null when the platform names no person (a deleted account, a bot). */
  author: string | null;
  /** Those asked now first, then those who reviewed and are not asked again. */
  reviewers: PullReviewer[];
  teams: PullTeamReviewer[];
  assignees: string[];
  /** True when the pull request has more reviews than one listing reads. */
  truncated: boolean;
};

export type PullCandidate = {
  login: string;
  /** The name the platform shows; null when it gives none. */
  name: string | null;
};

export type PullCandidatesView = {
  /** The repository's people whose login starts with the prefix, without case, at most MAX_PEOPLE_CANDIDATES. */
  candidates: PullCandidate[];
  /** True when more may match than were read or answered. */
  truncated: boolean;
};

/** Adds and removes people by login; a login in neither list is left as it is. */
export type PullPeopleRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  add: string[];
  remove: string[];
};

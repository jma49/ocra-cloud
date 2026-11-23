import type { CodePlatformKind } from "./domain.js";
import type { PullState } from "./pull-page.js";

// A pull request's labels and draft state, read live as the signed-in user
// and changed as them: what the platform's own sidebar edits.

/** Repository labels one listing reads, and labels one edit adds or removes. */
export const MAX_REPO_LABELS = 100;
export const MAX_LABEL_EDITS = 20;
/** A label's name, as long as GitLab takes one. */
export const MAX_LABEL_CHARS = 255;

export type PullLabel = {
  name: string;
  /** `#rrggbb`, as the platform gave it; null when it gave none the console reads. */
  color: string | null;
  description: string | null;
};

export type PullLabelsView = {
  /** The pull request's labels, by name. */
  applied: string[];
  /** The repository's labels the user can pick from. */
  available: PullLabel[];
  /** True when the repository has more labels than one listing reads. */
  truncated: boolean;
};

/** Adds and removes labels by name; a name in neither list is left as it is. */
export type PullLabelsRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  add: string[];
  remove: string[];
};

export type PullDraftView = {
  draft: boolean;
  /** Only an open pull request is made a draft or ready. */
  state: PullState;
};

export type PullDraftRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  draft: boolean;
};

/**
 * What updating a pull request's branch from its base answered: `updating`
 * when the platform took it (it works asynchronously, a new head follows),
 * `up_to_date` when the base has nothing new, `conflicts` when only a
 * manual merge resolves it, `forbidden` when the user may not push to the
 * branch, `not_open` for one merged or closed.
 */
export type BranchUpdateOutcome =
  | "updating"
  | "up_to_date"
  | "conflicts"
  | "forbidden"
  | "not_open";

/**
 * POST /api/pulls/update-branch: GitHub merges the base into the branch,
 * GitLab rebases it. `head` is the head the user saw; one that moved since
 * is refused as `stale` (409), a used-up platform allowance as
 * `upstream_unreachable` with reason `platform_rate_limited`.
 */
export type PullUpdateBranchRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
};

export type PullUpdateBranchAnswer = { outcome: BranchUpdateOutcome };

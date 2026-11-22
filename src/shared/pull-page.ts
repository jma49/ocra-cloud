import type { CodePlatformKind } from "./domain.js";

// A pull request's page: its changed files with their diffs, and what the
// signed-in user can do on it from the console, as they would on the platform.

type PullFileStatus = "added" | "removed" | "modified" | "renamed";

type PullFileView = {
  path: string;
  oldPath: string;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  /** The unified diff's hunks; null when the platform sent none (binary, too large). */
  patch: string | null;
};

export type PullFilesView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  base: string;
  head: string;
  files: PullFileView[];
  /** True when the pull request has more files, or more diff, than one page reads. */
  truncated: boolean;
  /** What this platform lets the console do on the pull request. */
  verdicts: PullVerdict[];
  mergeMethods: MergeMethod[];
};

export const PULL_VERDICTS = ["approve", "request_changes", "comment"] as const;
export type PullVerdict = (typeof PULL_VERDICTS)[number];

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type LineSide = "old" | "new";

/** A comment on one line of the diff. */
export type LineComment = { path: string; line: number; side: LineSide; body: string };

/**
 * What a write on the pull request came to: `refused` when the platform
 * said no (no permission, closed, a line outside the diff), `head_moved`
 * when the pull request gained commits since the page was read (or, for a
 * fix, since the review), `not_applicable` when a fix's lines are not in the file.
 */
export type PullActionOutcome =
  | "done"
  | "refused"
  | "head_moved"
  | "not_mergeable"
  | "not_applicable";

/** Where a pull request stands in its base branch's merge queue (GitLab: merge train). */
export type QueueState = "waiting" | "checking" | "ready" | "merging" | "blocked";

export type MergeQueueView = {
  /** False when the base branch has no queue: the pull request is merged directly. */
  enabled: boolean;
  /** Null when the pull request is not in the queue. */
  entry: { state: QueueState; position: number | null } | null;
};

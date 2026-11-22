import type { CodePlatformKind } from "./domain.js";

// A pull request's page: its changed files with their diffs, and what the
// signed-in user can do on it from the console, as they would on the platform.

type PullFileStatus = "added" | "removed" | "modified" | "renamed";

export type PullFileView = {
  path: string;
  oldPath: string;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  /** The unified diff's hunks; null when the platform sent none (binary, too large). */
  patch: string | null;
  /**
   * Whether the user ticked it as viewed at its current content: a file
   * that changed since reads false. null when the platform did not say.
   */
  viewed: boolean | null;
};

/** Where a pull request stands: merged and closed ones take comments only. */
export type PullState = "open" | "merged" | "closed";

export type PullFilesView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  title: string | null;
  author: string | null;
  /** Its page on the platform. */
  url: string | null;
  /** null where the platform did not say; the console treats it as open. */
  state: PullState | null;
  base: string;
  head: string;
  /** The platform's updated_at, which POST /api/pulls/seen takes back to mark it read. */
  updatedAt: string | null;
  files: PullFileView[];
  /** True when the pull request has more files, or more diff, than one page reads. */
  truncated: boolean;
  /** What this platform lets the console do on the pull request. */
  verdicts: PullVerdict[];
  /**
   * The methods the repository allows, its default first (GitHub has none:
   * merge, squash, rebase, as its own merge button lists them); the
   * platform's own list where the repository's settings are not readable.
   * A merge of any other is refused with invalid_body before it is sent.
   */
  mergeMethods: MergeMethod[];
};

/** Where a head to compare from comes from: the inbox's read mark, or the user's latest review on the platform. */
type PullSinceSource = "seen" | "reviewed";

/** A head GET /api/pulls/since offers to compare from, and when the user saw or reviewed it. */
export type PullSinceOption = { source: PullSinceSource; head: string; at: string | null };

/**
 * What GET /api/pulls/since came to: `none` when there is no head to compare
 * from, `same` when it is the current head, `changes` with the diff,
 * `rebased` when a force push left it out of the current head's history,
 * `unavailable` when the platform could not compare (an unknown commit, a
 * comparison too large to read, or a failure).
 */
export type PullSinceState = "none" | "same" | "changes" | "rebased" | "unavailable";

/**
 * What changed in a pull request since a head: the files changed from
 * `since` to `head`, in PullFilesView's shape. `viewed` is always null: the
 * full page's files say it, by path.
 */
export type PullSinceView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  /** The head compared from: the one asked for, else the review's, else the read mark's. */
  since: string | null;
  state: PullSinceState;
  /** The reviewed head first, then the read mark's; each at most once per source. */
  options: PullSinceOption[];
  files: PullFileView[];
  truncated: boolean;
};

/** Files one POST /api/pulls/viewed ticks or unticks. */
export const MAX_VIEWED_PATHS = 100;

/** Ticks files as viewed, or unticks them, only while the pull request is at `head`. */
export type PullViewedRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  paths: string[];
  viewed: boolean;
};

export const PULL_VERDICTS = ["approve", "request_changes", "comment"] as const;
export type PullVerdict = (typeof PULL_VERDICTS)[number];

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type LineSide = "old" | "new";

/**
 * A comment on one line of the diff, or on the lines startLine to line, which
 * may carry a suggestion: the text those new lines should be instead.
 */
export type LineComment = {
  path: string;
  line: number;
  side: LineSide;
  body: string;
  startLine?: number | undefined;
  suggestion?: string | undefined;
};

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

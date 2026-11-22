import type { LineSide } from "./pull-page.js";

// A pull request's review threads, read live as the signed-in user: each
// with its comments, whether it is resolved, and the suggestions its
// comments carry, as the platform reads them.

/**
 * A suggested change: the new lines startLine to endLine replaced by
 * `replacement`. Only one on the head's lines as they were commented can be
 * applied; an outdated one is shown all the same.
 */
export type ThreadSuggestion = {
  /** What POST /api/pulls/apply-suggestions takes back. */
  id: string;
  startLine: number;
  endLine: number;
  replacement: string;
  applicable: boolean;
  applied: boolean;
};

export type ThreadComment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  suggestions: ThreadSuggestion[];
};

export type ReviewThreadView = {
  /** What POST /api/pulls/resolve-thread takes back. */
  id: string;
  path: string;
  /** The line on the head's diff; null when the thread is outdated. */
  line: number | null;
  startLine: number | null;
  side: LineSide;
  resolved: boolean;
  /** True when the lines it was written on changed since. */
  outdated: boolean;
  canResolve: boolean;
  comments: ThreadComment[];
};

export type PullThreadsView = {
  /** The head the threads were read at, which applying a suggestion takes back. */
  head: string;
  threads: ReviewThreadView[];
  /** True when the pull request has more threads, or a thread more comments, than one page reads. */
  truncated: boolean;
};

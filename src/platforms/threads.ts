import type { LineSide, PullActionOutcome } from "../shared/index.js";

// A pull request's review threads, read and acted on as the signed-in user:
// listed with their comments and suggestions, suggestions applied as one
// commit of the head the user saw, threads resolved and reopened. Each
// answers null when the platform could not be reached. Nothing is kept.

/** Threads and comments one listing reads, and suggestions one commit applies. */
export const MAX_THREADS = 100;
export const MAX_THREAD_COMMENTS = 50;
export const MAX_APPLIED_SUGGESTIONS = 20;

export type Suggestion = {
  id: string;
  startLine: number;
  endLine: number;
  replacement: string;
  applicable: boolean;
  applied: boolean;
};

export type Comment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  suggestions: Suggestion[];
};

export type Thread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: LineSide;
  resolved: boolean;
  outdated: boolean;
  canResolve: boolean;
  comments: Comment[];
};

type ThreadListing = { head: string; threads: Thread[]; truncated: boolean };

type SuggestionApply = { head: string; ids: string[] };

export interface PullThreads {
  list(token: string, fullName: string, number: number): Promise<ThreadListing | null>;
  /**
   * `head_moved` when the pull request is not at `head`, `not_applicable` when
   * a suggestion is not one of its applicable ones or its lines changed.
   */
  apply(
    token: string,
    fullName: string,
    number: number,
    apply: SuggestionApply,
  ): Promise<PullActionOutcome | null>;
  /** `refused` for a thread that is not one of the pull request's. */
  resolve(
    token: string,
    fullName: string,
    number: number,
    thread: string,
    resolved: boolean,
  ): Promise<PullActionOutcome | null>;
}

/** The listing's suggestions of these ids, or undefined when one is missing or cannot be applied. */
export function applicableOf<S extends Suggestion>(
  threads: { comments: { suggestions: S[] }[] }[],
  ids: readonly string[],
): S[] | undefined {
  const all = new Map(
    threads.flatMap((t) => t.comments.flatMap((c) => c.suggestions.map((s) => [s.id, s]))),
  );
  const picked = ids.map((id) => all.get(id));
  return picked.every((s): s is S => s?.applicable === true) ? picked : undefined;
}

/** A commit's message for `count` suggestions. */
export const suggestionMessage = (count: number) =>
  count === 1 ? "Apply a suggestion from review" : `Apply ${count} suggestions from review`;

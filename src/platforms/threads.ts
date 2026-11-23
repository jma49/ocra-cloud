import type { LineSide, PullActionOutcome } from "../shared/index.js";

// A pull request's review threads, read and acted on as the signed-in user:
// listed with their comments and suggestions, suggestions applied as one
// commit of the head the user saw, threads resolved, reopened and replied to. Each
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

/**
 * What an action did, and the fingerprints of ocra's findings whose comments
 * it acted on, as their markers read: any comment can carry one, so they
 * name only the signed-in account's own findings on this pull request.
 */
export type ThreadAction = { outcome: PullActionOutcome; findings: string[] };

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
  ): Promise<ThreadAction | null>;
  /** `refused` for a thread that is not one of the pull request's. */
  resolve(
    token: string,
    fullName: string,
    number: number,
    thread: string,
    resolved: boolean,
  ): Promise<ThreadAction | null>;
  /** Posts a reply as the user; `refused` for a thread that is not one of the pull request's. */
  reply(
    token: string,
    fullName: string,
    number: number,
    thread: string,
    body: string,
  ): Promise<PullActionOutcome | null>;
}

/** The marker ocra's inline comment starts with (the engine's vcs-platform render). */
const FINDING_MARKER = /<!-- ocra:finding ([0-9a-f]{16}) -->/;

/** The fingerprint of the finding a comment is ocra's comment of, if it is one. */
const findingOfComment = (body: string): string | undefined => FINDING_MARKER.exec(body)?.[1];

/**
 * The fingerprint of the finding a comment is ocra's comment of, for a
 * comment that starts with the marker as ocra writes it: a reply that
 * quotes one is not it.
 */
export const findingStarting = (body: string): string | undefined =>
  /^\s*<!-- ocra:finding ([0-9a-f]{16}) -->/.exec(body)?.[1];

/** The findings of the comments carrying these suggestions. */
export function findingsOfSuggestions(
  threads: { comments: { body: string; suggestions: { id: string }[] }[] }[],
  ids: readonly string[],
): string[] {
  const wanted = new Set(ids);
  const found = threads.flatMap((t) =>
    t.comments.flatMap((c) =>
      c.suggestions.some((s) => wanted.has(s.id)) ? [findingOfComment(c.body)] : [],
    ),
  );
  return [...new Set(found.filter((f): f is string => f !== undefined))];
}

/** The finding of the comment a thread starts with: ocra's comments start their threads. */
export function findingsOfThread(thread: { comments: { body: string }[] } | undefined): string[] {
  const first = thread?.comments[0] && findingOfComment(thread.comments[0].body);
  return first ? [first] : [];
}

/** An outcome, with these findings only when it was done. */
export const actionOf = (
  outcome: PullActionOutcome | null,
  findings: string[] = [],
): ThreadAction | null => outcome && { outcome, findings: outcome === "done" ? findings : [] };

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

import type { LineComment, MergeMethod, PullActionOutcome, PullVerdict } from "../shared/index.js";
import { type FixSkip, fixEach, type LineFix } from "./fix.js";

// What the signed-in user does on a pull request from the console, as
// themselves: the platform checks their permission, and its refusal is
// answered as one. Each answers null when the platform could not be reached.

type ReviewRequest = {
  verdict: PullVerdict;
  body: string;
  /** The head commit the user reviewed; a pull request that moved since is not reviewed. */
  head: string;
  comments: LineComment[];
};

type MergeRequest = { method: MergeMethod; head: string };

/** Fixes of the file at `path`, as it is at the commit's head. */
export type FileFixes = { path: string; fixes: LineFix[] };

/**
 * Fixes of files as they are at `head`, committed together on the pull
 * request's branch, with the message `message` gives for what is left
 * out. `partial` leaves out a fix that cannot be applied, where otherwise
 * it keeps the whole commit from being sent.
 */
export type FixCommit = {
  head: string;
  files: FileFixes[];
  message: (skipped: (FixSkip | null)[][]) => string;
  partial?: boolean;
};

/** What a fix commit came to, and per file, per fix, why it was left out (null when applied). */
export type FixCommitResult = { outcome: PullActionOutcome; skipped: (FixSkip | null)[][] };

/** A pull request's head commit and description (GitLab: a merge request's). */
type PullDescription = { head: string; body: string };

export interface PullActions {
  readonly verdicts: readonly PullVerdict[];
  /** What the console offers where the repository's own merge settings are not readable. */
  readonly mergeMethods: readonly MergeMethod[];
  /** The methods the repository allows, its default first; null when its settings are not readable. */
  allowedMergeMethods(token: string, fullName: string): Promise<MergeMethod[] | null>;
  comment(
    token: string,
    fullName: string,
    number: number,
    body: string,
  ): Promise<PullActionOutcome | null>;
  review(
    token: string,
    fullName: string,
    number: number,
    review: ReviewRequest,
  ): Promise<PullActionOutcome | null>;
  merge(
    token: string,
    fullName: string,
    number: number,
    merge: MergeRequest,
  ): Promise<PullActionOutcome | null>;
  /** Adds the labels to those it has, as the ocra bot for an automation. */
  addLabels(
    token: string,
    fullName: string,
    number: number,
    labels: readonly string[],
  ): Promise<PullActionOutcome | null>;
  /** Asks the users, by login, for a review, besides those it asked already. */
  requestReviewers(
    token: string,
    fullName: string,
    number: number,
    logins: readonly string[],
  ): Promise<PullActionOutcome | null>;
  /**
   * One commit of the fixed files; `not_applicable`, unsent, when no fix (or,
   * unless `partial`, not every fix) can be applied to its file at head.
   */
  applyFixes(
    token: string,
    fullName: string,
    number: number,
    commit: FixCommit,
  ): Promise<FixCommitResult | null>;
  /** null when it could not be read. */
  description(token: string, fullName: string, number: number): Promise<PullDescription | null>;
  /** Replaces the description; `head_moved`, unsent, when the head is no longer `edit.head`. */
  setDescription(
    token: string,
    fullName: string,
    number: number,
    edit: PullDescription,
  ): Promise<PullActionOutcome | null>;
}

/** A write's status as an outcome: a refusal for 4xx but 429 (try later), unreached for the rest. */
export function outcomeOf(
  sent: { status: number } | null,
  special: Partial<Record<number, PullActionOutcome>> = {},
): PullActionOutcome | null {
  if (!sent) return null;
  const named = special[sent.status];
  if (named) return named;
  if (sent.status >= 200 && sent.status < 300) return "done";
  if (sent.status >= 400 && sent.status < 500 && sent.status !== 429) return "refused";
  return null;
}

/** The files' new contents, and whether to send them: every fix applied, or with `partial` any. */
export function plannedFixes(reads: readonly (Uint8Array | undefined)[], commit: FixCommit) {
  const each = commit.files.map((f, i) => fixEach(reads[i], f.fixes));
  const skipped = each.map((e) => e.skipped);
  const changed = commit.files.flatMap((f, i) => {
    const content = each[i]?.content;
    return content ? [{ path: f.path, content }] : [];
  });
  const all = skipped.every((s) => s.every((x) => x === null));
  const send = changed.length > 0 && (commit.partial === true || all);
  return { changed, skipped, send, message: commit.message(skipped) };
}

/** What a commit that was not sent, for a reason of the pull request's and not its fixes', answers. */
export const unsent = (
  outcome: PullActionOutcome,
  files: readonly FileFixes[],
): FixCommitResult => ({
  outcome,
  skipped: files.map((f) => f.fixes.map(() => null)),
});

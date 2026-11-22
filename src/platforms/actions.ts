import type { LineComment, MergeMethod, PullActionOutcome, PullVerdict } from "../shared/index.js";
import type { LineFix } from "./fix.js";

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

/** A fix of the file at `path` as it is at `head`, committed on the pull request's branch. */
type FixCommit = { path: string; head: string; fix: LineFix; message: string };

export interface PullActions {
  readonly verdicts: readonly PullVerdict[];
  readonly mergeMethods: readonly MergeMethod[];
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
  /** `not_applicable` when the file at head is not text the fix's lines are in. */
  applyFix(
    token: string,
    fullName: string,
    number: number,
    commit: FixCommit,
  ): Promise<PullActionOutcome | null>;
}

/** A write's status as an outcome: a refusal for 4xx, unreached for the rest. */
export function outcomeOf(
  sent: { status: number } | null,
  special: Partial<Record<number, PullActionOutcome>> = {},
): PullActionOutcome | null {
  if (!sent) return null;
  const named = special[sent.status];
  if (named) return named;
  if (sent.status >= 200 && sent.status < 300) return "done";
  if (sent.status >= 400 && sent.status < 500) return "refused";
  return null;
}

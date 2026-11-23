import type {
  PullActionOutcome,
  PullCandidate,
  PullReviewer,
  PullTeamReviewer,
  ReviewerState,
} from "../shared/index.js";

// Who a pull request asks for a review and is assigned to, and the
// repository's people one can ask, read and changed as the signed-in user.
// Each answers null when the platform could not be reached or refused the
// read (a pull request the user cannot see reads as one that is not there).

type PullRosterRead = {
  author: string | null;
  reviewers: PullReviewer[];
  teams: PullTeamReviewer[];
  assignees: string[];
  truncated: boolean;
};

type CandidateListing = { candidates: PullCandidate[]; truncated: boolean };

/** Logins, already checked against LOGIN and distinct without case. */
export type PeopleEdit = { add: readonly string[]; remove: readonly string[] };

export interface PullRoster {
  read(token: string, fullName: string, number: number): Promise<PullRosterRead | null>;
  /** Users whose login starts with `prefix`, without case, at most `limit`. */
  candidates(
    token: string,
    fullName: string,
    prefix: string,
    limit: number,
  ): Promise<CandidateListing | null>;
  /** Asks the added for a review, and stops asking the removed; a review already given stays. */
  editReviewers(
    token: string,
    fullName: string,
    number: number,
    edit: PeopleEdit,
  ): Promise<PullActionOutcome | null>;
  editAssignees(
    token: string,
    fullName: string,
    number: number,
    edit: PeopleEdit,
  ): Promise<PullActionOutcome | null>;
}

/** Logins compared as the platforms compare them, without case. */
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const startsWith = (login: string, prefix: string) =>
  login.toLowerCase().startsWith(prefix.toLowerCase());

/**
 * Each reviewer's standing from their reviews, oldest first: a later verdict
 * replaces an earlier one, a comment only stands where there was none.
 * Those asked now are `requested`, whatever they answered before.
 */
export function reviewerStates(
  requested: readonly string[],
  reviews: readonly { login: string; state: ReviewerState }[],
  author: string | null,
): PullReviewer[] {
  const states = new Map<string, PullReviewer>();
  for (const login of requested) states.set(login.toLowerCase(), { login, state: "requested" });
  for (const r of reviews) {
    if (author && sameLogin(r.login, author)) continue;
    const key = r.login.toLowerCase();
    const seen = states.get(key);
    if (seen?.state === "requested") continue;
    if (r.state === "commented" && seen) continue;
    states.set(key, { login: r.login, state: r.state });
  }
  return [...states.values()];
}

/** The listed, exact match first, then by login. */
export const byLogin = (prefix: string) => (a: PullCandidate, b: PullCandidate) => {
  const exact = Number(sameLogin(b.login, prefix)) - Number(sameLogin(a.login, prefix));
  return exact || a.login.toLowerCase().localeCompare(b.login.toLowerCase());
};

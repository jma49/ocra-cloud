// Who a pull request involves, and how many reviews someone is asked for,
// read as the signed-in user for the reviewers the console suggests.
// Each answers null when the platform could not be reached.

type PullPeople = {
  /** The repository's own id on the platform, for reading its files. */
  platformRepoId: string;
  author: string | null;
  /** The base branch's commit the pull request is against. */
  base: string;
  /** Users asked for a review now. */
  requested: string[];
};

export interface PullReviewers {
  people(token: string, fullName: string, number: number): Promise<PullPeople | null>;
  /** Each login's open pull requests asking them for a review; null for one not read. */
  load(token: string, logins: readonly string[]): Promise<(number | null)[]>;
}

/** A login as both platforms write one, safe inside a search. */
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** GitHub Apps, and GitLab's project and group access tokens. */
export const isBotLogin = (login: string) =>
  /\[bot\]$/i.test(login) || /^(project|group)_\d+_bot/i.test(login);

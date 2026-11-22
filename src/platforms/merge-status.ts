import type { MergeChecksConclusion } from "../shared/index.js";

// What pre-merge checks read of a pull request, and where their result is
// posted: one check run on GitHub (the App's installation token, Checks
// write), one commit status on GitLab, both named CHECK_NAME.

export const CHECK_NAME = "ocra / pre-merge";

export type PullFacts = {
  title: string;
  description: string;
  head: string;
  files: number;
  /** Lines added and removed. */
  lines: number;
  /** False when the platform listed more files than were counted: files and lines are at least these. */
  exact: boolean;
};

export type PostedStatus = {
  conclusion: MergeChecksConclusion;
  /** One line. */
  title: string;
  /** Markdown, one line per check. */
  summary: string;
  detailsUrl: string;
};

export interface PullMergeStatus {
  /** null when the token does not reach the pull request, or the platform failed. */
  facts(token: string, fullName: string, number: number): Promise<PullFacts | null>;
  /**
   * Posts the status on the head, updating the earlier post `previous` names;
   * the platform's id of what it posted, or null when it was refused.
   */
  publish(
    token: string,
    fullName: string,
    head: string,
    status: PostedStatus,
    previous: string | null,
  ): Promise<string | null>;
}

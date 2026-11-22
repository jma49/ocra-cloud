import type { CodePlatformKind } from "./domain.js";

// "Open an issue" on a review's finding: a draft from the finding, edited
// in the console and opened in the reviewed repository as the user, once
// per finding.

/** As long as GitLab takes an issue's title (GitHub takes 256). */
export const MAX_ISSUE_TITLE_CHARS = 255;
/** As long as GitHub takes an issue's body. */
export const MAX_ISSUE_BODY_CHARS = 65_536;

/** An issue opened from a finding: its number in the repository and its page. */
export type FindingIssueView = { number: number; url: string };

export type FindingIssueDraftView = {
  platform: CodePlatformKind;
  /** The repository the issue is opened in, as the platform names it. */
  repo: string;
  title: string;
  body: string;
  /** The issue already opened from the finding, which a create answers instead of opening another. */
  issue: FindingIssueView | null;
};

export type FindingIssueRequest = { title: string; body: string };

/**
 * `done` with the issue, `created` false when it had been opened already;
 * `refused` when the platform refused (no permission, issues turned off);
 * `pending` while another request is opening it.
 */
export type FindingIssueAnswer =
  | { outcome: "done"; issue: FindingIssueView; created: boolean }
  | { outcome: "refused" }
  | { outcome: "pending" };

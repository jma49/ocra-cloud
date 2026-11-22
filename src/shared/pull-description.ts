import type { CodePlatformKind } from "./domain.js";

// "Write the PR description" on a pull request's page: a draft built from
// ocra's stored review of the pull request, without a model, that the user
// edits and saves to the platform as themselves.

/** As long as GitHub takes a pull request's body; GitLab takes more. */
export const MAX_DESCRIPTION_CHARS = 65_536;

/** Where ocra's section of a description starts and ends; the rest is the user's own text. */
export const DESCRIPTION_START = "<!-- ocra:description:start -->";
export const DESCRIPTION_END = "<!-- ocra:description:end -->";

export type PullDescriptionDraftView = {
  /** The pull request's head now: the save names it, and is refused once it moved. */
  head: string;
  /** Its description now, as the platform has it. */
  body: string;
  /** The description with ocra's section in place of the one it had, or added; null with no review of the pull request. */
  draft: string | null;
  /** The review the draft is from: of the head now when there is one, else the newest. */
  review: { id: string; head: string; current: boolean; createdAt: string } | null;
};

export type PullDescriptionRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  body: string;
};

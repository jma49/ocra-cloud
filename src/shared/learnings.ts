import type { LearningSourceKind } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";

// A repository's learnings (ADR-0037 of the engine), read live from its
// default branch as the signed-in user, the pull requests that propose new
// ones, and the console's changes to them, each sent as a commit of the user.

type LastCommit = {
  sha: string;
  /** null where the platform does not say when, in the same call. */
  at: string | null;
};

export type LearningView = {
  /** The file name without `.md`. */
  id: string;
  path: string;
  /** The file's git blob id: a change names it, and one made since answers `conflict`. */
  blobId: string;
  title: string;
  body: string;
  paths: string[];
  symbols: string[];
  keywords: string[];
  critical: boolean;
  source: { kind: LearningSourceKind; ref: string | null } | null;
  created: string;
  lastCommit: LastCommit | null;
};

/** A file under the learnings directory that a review would skip, and why. */
export type InvalidLearningView = { path: string; blobId: string; reason: string };

export type LearningsView = {
  platform: CodePlatformKind;
  repo: string;
  branch: string;
  commit: string;
  learnings: LearningView[];
  invalid: InvalidLearningView[];
  /** The files in the directory, this page's and the others'. */
  total: number;
  /** The `after` of the next page; null on the last. */
  next: string | null;
};

export type LearningProposalView = {
  number: number;
  title: string;
  url: string;
  branch: string;
  head: string;
  author: string | null;
  createdAt: string;
  /** The learnings it adds or changes, as they are at its head. */
  learnings: LearningView[];
  invalid: InvalidLearningView[];
  /** The ids of the learnings it deletes. */
  removed: string[];
};

export type LearningProposalsView = {
  proposals: LearningProposalView[];
  /** True when more were open than one request reads. */
  more: boolean;
};

/**
 * What a change came to: `conflict` when the file is not as the console
 * read it (changed, deleted, or added since), `refused` when the platform
 * said no (no permission, a protected branch).
 */
export type LearningChangeOutcome = "done" | "refused" | "conflict";

export type LearningChangeView = {
  outcome: LearningChangeOutcome;
  path: string;
  /** The pull request the change was opened as; null when committed to the default branch, or not done. */
  pull: { number: number; url: string } | null;
};

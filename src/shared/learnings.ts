import type { LearningSourceKind } from "@open-cr-agent/cloud-contract";
import type { LearnJobView, LearnMode } from "./auto-review.js";
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

/** How many of the repository's uploaded reviews were given a learning, and the newest's time. */
export type LearningUsageView = { reviews: number; lastUsedAt: string | null };

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
  /** Per learning of this page: the repository's reviews given it in the last usageDays. */
  usage: Record<string, LearningUsageView>;
  usageDays: number;
  /**
   * Per learning of this page, its paths that match no file at the commit:
   * reviews no longer give it by path. null when the files could not all be listed.
   */
  unmatchedPaths: Record<string, string[]> | null;
  /** The `after` of the next page; null on the last. */
  next: string | null;
  /** How the findings people decline become learnings here; null unless the server reviews the repository. */
  declined: DeclinedLearningView | null;
};

/**
 * An enrolled repository's learning from declined findings: its setting,
 * and the pull requests whose threads are waiting to be read, being read
 * or were read lately, newest first.
 */
export type DeclinedLearningView = {
  reviewRepoId: string;
  learn: LearnMode;
  jobs: LearnJobView[];
};

export type LearningProposalView = {
  number: number;
  title: string;
  url: string;
  branch: string;
  head: string;
  author: string | null;
  createdAt: string;
  /** The platform merges it once what the branch requires is met; otherwise a person does. */
  autoMerge: boolean;
  /** Who it asks to review it. */
  reviewers: string[];
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
 * What a change to a repository's file came to: `conflict` when the file is
 * not as the console read it (changed, deleted, or added since), `refused`
 * when the platform said no (no permission, a protected branch).
 */
export type FileChangeOutcome = "done" | "refused" | "conflict";

export type LearningChangeView = {
  outcome: FileChangeOutcome;
  path: string;
  /** The pull request the change was opened as; null when committed to the default branch, or not done. */
  pull: { number: number; url: string } | null;
};

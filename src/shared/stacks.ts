import type { CodePlatformKind } from "./domain.js";
import type { PullActionOutcome } from "./pull-page.js";
import type { PullChecks, PullReview } from "./pulls.js";

// A stack of pull requests, read from the platform: one whose base branch is
// another open one's head is stacked on it (ADR-0051).

export type StackedPull = {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** Branch names. */
  head: string;
  base: string;
  /** The head commit, which a merge of the stack names so a moved one is not merged blind. */
  headSha: string;
  /** The pull request it is stacked on; null for the bottom. */
  parent: number | null;
  checks: PullChecks;
  review: PullReview;
};

export type PullStackView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  /** The bottom's base branch, where the stack merges to. */
  trunk: string;
  /** Bottom to top, each after its parent; empty when the pull request is not open. */
  pulls: StackedPull[];
};

/** `unreached` when the platform did not answer; the steps after a stop are not tried. */
export type StackStepOutcome = PullActionOutcome | "unreached";

export type StackMergeStep = { number: number; outcome: StackStepOutcome };

export type StackMergeView = { steps: StackMergeStep[] };

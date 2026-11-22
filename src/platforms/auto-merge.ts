import type { MergeMethod, PullActionOutcome } from "../shared/index.js";

// The platform's own auto-merge, used as the signed-in user (GitHub's
// auto-merge, GitLab's merge when the pipeline succeeds), and what the
// server reads of a pull request to merge it itself where that is off.
// Each answers null when the platform could not be reached.

/** Where a pull request stands for a merge, as the platform says. */
type PullReadiness = {
  state: "open" | "merged" | "closed";
  head: string;
  /** Whether the platform would merge it now: required checks, approvals, no conflicts. */
  mergeable: boolean;
};

/** `unavailable` when the repository has it off; `ready` when it would merge now, so arms nothing. */
type AutoMergeOutcome = PullActionOutcome | "unavailable" | "ready";

export interface PullAutoMerge {
  /** Arms it at `head`, the commit the user saw; a pull request that moved since is `head_moved`. */
  enable(
    token: string,
    fullName: string,
    number: number,
    merge: { method: MergeMethod; head: string },
  ): Promise<AutoMergeOutcome | null>;
  /** `done` also when it was not armed. */
  disable(token: string, fullName: string, number: number): Promise<PullActionOutcome | null>;
  readiness(token: string, fullName: string, number: number): Promise<PullReadiness | null>;
}

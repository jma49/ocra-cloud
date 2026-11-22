import type { PullFacts } from "./merge-status.js";

// What a pull request's merge readiness is read from, as the signed-in
// user: GitHub answers it in one GraphQL query, GitLab in a few bounded
// calls. A field the token cannot read is null, never a default.

/** Review threads, changed files and checks one reading takes. */
export const MAX_READINESS_THREADS = 100;
export const MAX_READINESS_FILES = 100;
export const MAX_READINESS_CHECKS = 100;

export type ReviewDecision = "approved" | "review_required" | "changes_requested" | "none_required";

/** A reviewer's newest approval; GitHub names the teams it was given for. */
export type Approval = { login: string; atHead: boolean; teams: string[] };

type CheckState = "passed" | "failed" | "pending";
export type CheckRun = { name: string; state: CheckState; required: boolean | null };

/** A GitLab code owner approval rule: one CODEOWNERS section's or pattern's. */
export type OwnerRule = {
  name: string;
  owners: string[];
  approved: boolean;
  approvedBy: string[];
  required: boolean;
};

export type ReadinessFacts = {
  state: "open" | "merged" | "closed";
  head: string;
  platformRepoId: string;
  draft: boolean;
  /** null while the platform is still working it out. */
  conflicts: boolean | null;
  /** The platform's own word that nothing blocks the merge; null when it gave none. */
  mergeable: boolean | null;
  reviews: {
    required: number | null;
    decision: ReviewDecision | null;
    dismissesStale: boolean | null;
    requiresCodeOwners: boolean | null;
    approvals: Approval[];
  };
  checks: {
    /** Names the branch rule requires; null when unreadable. */
    required: string[] | null;
    runs: CheckRun[];
    truncated: boolean;
  } | null;
  threads: { unresolved: number; truncated: boolean } | null;
  changed: { paths: string[]; truncated: boolean } | null;
  /** null when the base has no CODEOWNERS; text null when it is too large or binary. */
  codeowners: { path: string; text: string | null } | null | "unreadable";
  /** The platform's own code owner rules, where it keeps them (GitLab Premium). */
  ownerRules: OwnerRule[] | null;
  /** What the pre-merge checks read, when it came with the rest. */
  facts: PullFacts | null;
};

export interface PullReadiness {
  /** null when the token does not reach the pull request, or the platform failed. */
  read(token: string, fullName: string, number: number): Promise<ReadinessFacts | null>;
}

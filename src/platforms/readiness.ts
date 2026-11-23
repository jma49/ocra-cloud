import type { PullFacts } from "./merge-status.js";

// What a pull request's merge readiness is read from, as the signed-in
// user: GitHub answers it in one GraphQL query, GitLab in a few bounded
// calls. A field the token cannot read is null, never a default.

/** Review threads, changed files and checks one reading takes. */
export const MAX_READINESS_THREADS = 100;
export const MAX_READINESS_FILES = 100;
export const MAX_READINESS_CHECKS = 100;

/**
 * What the platform said of the base branch's protection rule: read, none
 * (it said the branch is not protected), unreadable (refused or not
 * answered) or unavailable (it said the repository's plan has none).
 */
export type BranchRuleRead = "read" | "none" | "unreadable" | "unavailable";

/**
 * GitHub's rulesets on the base branch: read, partial (more rules than one
 * page lists) or unreadable (refused or not answered, read as none).
 */
export type RulesetsRead = "read" | "partial" | "unreadable";

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
  /**
   * Whether the platform holds the merge back until the branch has its
   * base's new commits (GitHub: required up to date; GitLab: a rebase
   * needed); null while it is still working it out or did not say.
   */
  behind: boolean | null;
  /** GitHub's branch protection rule; null where approvals are read without one (GitLab). */
  branchRule: BranchRuleRead | null;
  /** GitHub's rulesets; null on GitLab. */
  rulesets: RulesetsRead | null;
  /** Rule types that can block the merge which no item judges (GitHub ruleset types). */
  otherRules: string[];
  /** Whether the rules require every thread resolved; null when not read. */
  resolveThreads: boolean | null;
  /** The platform's own word that nothing blocks the merge; null when it gave none. */
  mergeable: boolean | null;
  reviews: {
    required: number | null;
    /** Approvals a rule read is known to require while `required` is not known. */
    requiredAtLeast: number;
    decision: ReviewDecision | null;
    dismissesStale: boolean | null;
    requiresCodeOwners: boolean | null;
    approvals: Approval[];
  };
  checks: {
    /** Names the branch rule requires; null when unreadable. */
    required: string[] | null;
    /** Names a rule read is known to require while `required` is not known. */
    requiredAtLeast: string[];
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

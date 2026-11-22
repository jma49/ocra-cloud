import type { CodePlatformKind } from "./domain.js";

// What still stands between a pull request and its merge, read live as the
// signed-in user: one item per requirement, each met, unmet, pending (the
// platform is still working it out) or unknown (the platform did not
// answer it, or it was not readable). Nothing is guessed: a requirement
// not read is unknown, and a detail names only what the platform said.

const READINESS_KINDS = [
  "draft",
  "conflicts",
  "approvals",
  "code_owners",
  "required_checks",
  "threads",
  "premerge_checks",
] as const;
export type ReadinessKind = (typeof READINESS_KINDS)[number];

const READINESS_STATES = ["met", "unmet", "pending", "unknown"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export type ReadinessItem = {
  kind: ReadinessKind;
  state: ReadinessState;
  /** One line for the user. */
  detail: string;
};

/**
 * The changed files that share one set of code owners (a GitLab section
 * is its own group): `met` when one of them approved at a head that still
 * counts, `unknown` when only teams, roles or emails it cannot resolve
 * remain.
 */
export type CodeOwnerGroupView = {
  owners: string[];
  /** Changed files the group owns; null when the platform's own rule is shown. */
  files: number | null;
  state: ReadinessState;
  approvedBy: string[];
  /** Whether the platform requires this group's approval; null when unreadable. */
  required: boolean | null;
};

/** GET /api/pulls/readiness?platform=&repo=&number= */
export type PullReadinessView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  state: "open" | "merged" | "closed";
  head: string;
  /**
   * The worst of the items (unmet, then pending, then unknown, then met);
   * null when the pull request is no longer open and lists no items.
   */
  ready: ReadinessState | null;
  items: ReadinessItem[];
  codeOwners: CodeOwnerGroupView[];
  /** Logins whose approval is of an earlier head. */
  staleApprovals: string[];
  /**
   * Branch rules that can hold the merge back which no item judges, by the
   * platform's own rule type (GitHub rulesets: merge_queue,
   * required_signatures, ...); empty when there are none or none were read.
   */
  otherRules: string[];
};

import type { SharedLinkedTask, SharedMergeCheck } from "@open-cr-agent/cloud-contract";

// Pre-merge checks: what an account asks of an enrolled repository's pull
// requests before they merge, each check off, a warning or blocking, and
// how a pull request's head fared, posted as one check run or commit status.

export const MERGE_CHECK_KINDS = [
  "linked_issue",
  "title",
  "description",
  "size",
  "critical_findings",
  "instruction",
] as const;
export type MergeCheckKind = (typeof MERGE_CHECK_KINDS)[number];

export const MERGE_CHECK_MODES = ["off", "warn", "block"] as const;
type MergeCheckMode = (typeof MERGE_CHECK_MODES)[number];

/** Each kind's settings. A title's glob takes `*` and `?` only, never a regular expression. */
export type MergeCheckSettings = {
  linked_issue: { open?: boolean | undefined; label?: string | undefined };
  title: { prefixes?: string[] | undefined; glob?: string | undefined };
  description: { headings?: string[] | undefined };
  size: { maxFiles?: number | undefined; maxLines?: number | undefined };
  critical_findings: Record<string, never>;
  /** A rule in plain words, which the review of the pull request judges. */
  instruction: { text: string };
};

export type MergeCheckView = {
  [K in MergeCheckKind]: {
    id: string;
    kind: K;
    mode: MergeCheckMode;
    settings: MergeCheckSettings[K];
    createdAt: string;
  };
}[MergeCheckKind];

/**
 * A task the pull request links, as the review uploads it: title and
 * labels only when the account shares findings; null for an entry that
 * did not fit.
 */
export type LinkedTaskView = SharedLinkedTask | null;

/**
 * A plain-language check's outcome, as the head's review uploads it: its
 * reason only when the account shares findings; null for an entry that
 * did not fit. Its id is the one the server gave the review (instructionCheckId).
 */
export type MergeCheckVerdictView = SharedMergeCheck | null;

/** `not_evaluated` never fails the pull request: the detail says what it waits for. */
type MergeCheckOutcome = "passed" | "failed" | "not_evaluated";

export type MergeCheckResultView = {
  id: string;
  kind: MergeCheckKind;
  mode: Exclude<MergeCheckMode, "off">;
  outcome: MergeCheckOutcome;
  detail: string;
};

/**
 * `failure` when a blocking check failed, `pending` while a blocking check
 * waits on the head's review (when the repository holds for it), `neutral`
 * when only warnings failed.
 */
export type MergeChecksConclusion = "success" | "neutral" | "failure" | "pending";

export type MergeChecksReportView = {
  head: string;
  conclusion: MergeChecksConclusion;
  results: MergeCheckResultView[];
};

/** An enrolled repository's checks, and whether they hold a head its review has not reached. */
export type RepoChecksView = { checks: MergeCheckView[]; holdUnreviewed: boolean };

/** A pull request's checks for the page: null when its repository is not enrolled or has none. */
export type PullChecksView = {
  report: MergeChecksReportView | null;
  /** When this head's result was last posted to the platform, if this host posts them. */
  postedAt: string | null;
};

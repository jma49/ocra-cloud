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
  /** A rule in plain words, which the engine is to judge; not evaluated yet. */
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
 * A task the pull request links, as the review uploads it (the contract's
 * linked tasks): title and labels only when the account shares findings;
 * null for an entry that did not fit.
 */
export type LinkedTaskView = {
  tracker: "github" | "gitlab";
  key: string;
  url?: string | undefined;
  state: "open" | "closed" | null;
  title?: string | undefined;
  labels?: string[] | undefined;
} | null;

/** `not_evaluated` never fails the pull request: the detail says what it waits for. */
type MergeCheckOutcome = "passed" | "failed" | "not_evaluated";

export type MergeCheckResultView = {
  id: string;
  kind: MergeCheckKind;
  mode: Exclude<MergeCheckMode, "off">;
  outcome: MergeCheckOutcome;
  detail: string;
};

/** `failure` when a blocking check failed, `neutral` when only warnings did. */
export type MergeChecksConclusion = "success" | "neutral" | "failure";

export type MergeChecksReportView = {
  head: string;
  conclusion: MergeChecksConclusion;
  results: MergeCheckResultView[];
};

/** A pull request's checks for the page: null when its repository is not enrolled or has none. */
export type PullChecksView = {
  report: MergeChecksReportView | null;
  /** When this head's result was last posted to the platform, if this host posts them. */
  postedAt: string | null;
};

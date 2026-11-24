// What the account's findings say about its reviews, for the Insights page:
// the console's decisions, the platform's outcomes and the 👍 and 👎 people
// gave ocra's comments on the platform. Only shared findings count, one
// row for each review that reported it; the reviews' own counts may be more.

import type { FINDING_RULE_KINDS } from "@open-cr-agent/cloud-contract";

/** A repository rule, or a learning (whose id is its file name), as the review named it. */
export type FindingRuleKind = (typeof FINDING_RULE_KINDS)[number];
/** The rule a finding says it applies; null when it named none, which is not "no rule applied". */
export type FindingRule = { kind: FindingRuleKind; id: string } | null;

/** One group of findings (a reviewer, severity, category or verification; key null for none). */
export type FindingInsightRow = {
  key: string | null;
  total: number;
  open: number;
  fixed: number;
  dismissed: number;
  /** Its comment's thread resolved by a person: not counted as accepted. */
  addressed: number;
  /** Its pull request merged with it still open. */
  merged: number;
  /** Fixed, or given a 👍 on its comment; a finding that is both counts once. */
  accepted: number;
  /** Given at least one 👍, or 👎, on its comment. */
  thumbsUp: number;
  thumbsDown: number;
  /** Given either. */
  reacted: number;
  /** fixed / (fixed + dismissed); null before any. */
  acceptanceRate: number | null;
  /** thumbsUp / reacted, and thumbsDown / reacted; null before any reaction. */
  thumbsUpRate: number | null;
  downvoteRate: number | null;
};

/** One rule's findings: key `<kind>:<id>`, null for the findings that named none. */
export type FindingRuleInsightRow = FindingInsightRow & {
  rule: FindingRule;
  /** What the page shows: the id, as Cloud holds no rule's text nor learning's title. */
  label: string | null;
};

/** At most this many rules in byRule, by findings; `otherRules` sums the rest. */
export const MAX_RULE_ROWS = 20;

/** GET /api/findings/insights?days= */
export type FindingInsightsView = {
  days: number;
  total: Omit<FindingInsightRow, "key">;
  byReviewer: FindingInsightRow[];
  bySeverity: FindingInsightRow[];
  byCategory: FindingInsightRow[];
  byVerification: FindingInsightRow[];
  byRule: FindingRuleInsightRow[];
  /** The rules past MAX_RULE_ROWS, summed; null when there are none. */
  otherRules: (Omit<FindingInsightRow, "key"> & { rules: number }) | null;
  dismissReasons: { key: string | null; n: number }[];
};

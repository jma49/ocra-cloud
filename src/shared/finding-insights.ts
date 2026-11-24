// What the account's findings say about its reviews, for the Insights page:
// the console's decisions, the platform's outcomes and the 👍 and 👎 people
// gave ocra's comments on the platform. Only shared findings count.

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

/** GET /api/findings/insights?days= */
export type FindingInsightsView = {
  days: number;
  total: Omit<FindingInsightRow, "key">;
  byReviewer: FindingInsightRow[];
  bySeverity: FindingInsightRow[];
  byCategory: FindingInsightRow[];
  byVerification: FindingInsightRow[];
  dismissReasons: { key: string | null; n: number }[];
};

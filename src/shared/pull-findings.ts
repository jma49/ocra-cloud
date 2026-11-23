import type { Severity } from "./domain.js";

// The open findings of ocra's review of a pull request as its page draws
// them on the diff: under the line each one ends on, at the reviewed head.

export type PullFindingView = {
  id: string;
  severity: Severity;
  title: string;
  /** What the reviewer wrote: a model's text about untrusted code. */
  body: string;
  file: string;
  /** null for a finding about the file as a whole. */
  lineStart: number | null;
  lineEnd: number | null;
  /** Whether a checked fix of it is offered beside it (GET /api/pulls/fixes). */
  hasFix: boolean;
};

/** GET /api/pulls/findings?platform=&repo=&number=&head= */
export type PullFindingsView = {
  /** The review the findings come from; null when none reviewed the pull request at this head. */
  review: { id: string; head: string } | null;
  findings: PullFindingView[];
};

import type { PullActionOutcome } from "../../../src/shared/index.js";

/** What a write on a pull request came to, in words for the person. */
export const OUTCOME: Record<PullActionOutcome, string> = {
  done: "Done.",
  refused: "The platform refused it: check your permission on the repository.",
  head_moved: "The pull request gained commits since this page loaded. Reload to see them.",
  not_mergeable:
    "The platform says it cannot be merged as it is (conflicts, required checks or approvals).",
  not_applicable: "The fix's lines are no longer in the file.",
};

/** What the PR page names a write by, when it reports how it went. */
export type Done =
  | "Viewed"
  | "Draft"
  | "Description"
  | "Review threads"
  | "Merge queue"
  | "Merge"
  | "Labels"
  | "Fix"
  | "Review";

/** The toast for a write that went through; none where the page already shows the change. */
export const DONE: Record<Done, string | null> = {
  Viewed: null,
  Draft: null,
  Description: "Description saved",
  "Review threads": "Suggestions committed",
  "Merge queue": "Merge queue updated",
  Merge: "Merged",
  Labels: "Labels saved",
  Fix: "Fix committed",
  Review: "Review sent",
};

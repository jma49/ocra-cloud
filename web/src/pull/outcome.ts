import type { PullActionOutcome } from "../../../src/shared/index.js";

/** What a write on a pull request came to, in words for the person. */
export const OUTCOME: Record<PullActionOutcome, string> = {
  done: "Done.",
  refused: "The platform refused it: check your permission on the repository.",
  head_moved: "The pull request gained commits since this page loaded. Reload to see them.",
  not_mergeable: "The platform says it cannot be merged as it is (conflicts or required checks).",
  not_applicable: "The fix's lines are no longer in the file.",
};

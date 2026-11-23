import type { ReviewDepth } from "../../../src/shared/index.js";

/** How each depth reads in the console: its name, and what a review at it does. */
export const DEPTH: Record<ReviewDepth, { name: string; says: string }> = {
  quick: {
    name: "Quick",
    says: "Without the performance, docs and AGENTS.md reviewers. Changed lines only, at most 10 inline comments, warnings or worse.",
  },
  standard: { name: "Standard", says: "The reviewers the change's size and paths call for." },
  deep: { name: "Deep", says: "Every reviewer, two samples each. About twice the cost." },
};

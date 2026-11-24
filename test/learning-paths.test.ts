import { describe, expect, it } from "vitest";
import { unmatchedPaths } from "../src/learning-paths.js";

// A learning's paths read as the engine reads them (.gitignore style), so
// a path is reported only when no file of the tree would give it to a review.

const tree = (...paths: string[]) => ({
  truncated: false,
  entries: paths.map((path) => ({ path, blobId: "b" })),
});

describe("unmatchedPaths", () => {
  it("reads paths as the engine does: bare names at any depth, directories, case ignored", () => {
    const files = tree("services/Billing/charge.ts", "db/migrations/001.sql", "Dockerfile");
    const learnings = [
      { id: "a", paths: ["*.sql", "services/billing/", "dockerfile"] },
      { id: "b", paths: ["/charge.ts", "services/payments/**"] },
      { id: "c", paths: [] },
    ];
    expect(unmatchedPaths(learnings, files)).toEqual({
      b: ["/charge.ts", "services/payments/**"],
    });
  });

  it("tells nothing when the tree is unknown or cut short", () => {
    const learnings = [{ id: "a", paths: ["gone/**"] }];
    expect(unmatchedPaths(learnings, null)).toBeNull();
    expect(unmatchedPaths(learnings, { ...tree(), truncated: true })).toBeNull();
  });
});

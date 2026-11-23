import { describe, expect, it } from "vitest";
import { batchMessage, combineEdits } from "../src/pull-batch.js";

// How a batch's items become one commit: which edits share a place, which
// conflict, and the commit's message.

describe("combining the edits of a batch", () => {
  const edit = (path: string, startLine: number, endLine: number, replacement: string) => ({
    path,
    fix: { startLine, endLine, replacement },
  });

  it("groups them by file, shares a place for the same change, and refuses an overlap after the first", () => {
    const { files, places } = combineEdits([
      edit("a", 3, 4, "x"),
      edit("b", 1, 1, "y"),
      edit("a", 3, 4, "x\n"),
      edit("a", 4, 6, "z"),
      edit("a", 5, 6, "w"),
      "no_fix",
      edit("a", 1, 2, "v"),
    ]);
    expect(files.map((f) => [f.path, f.fixes.map((x) => x.startLine)])).toEqual([
      ["a", [3, 5, 1]],
      ["b", [1]],
    ]);
    expect(places).toEqual([
      { file: 0, fix: 0 },
      { file: 1, fix: 0 },
      { file: 0, fix: 0 },
      "conflict",
      { file: 0, fix: 1 },
      "no_fix",
      { file: 0, fix: 2 },
    ]);
  });

  it("names the commit by what it applies", () => {
    expect(batchMessage(["Leak"], 0)).toBe("Apply ocra's fix: Leak");
    expect(batchMessage([], 3)).toBe("Apply 3 suggestions from review");
    expect(batchMessage(["A", "B"], 0)).toBe("Apply 2 fixes from ocra");
    expect(batchMessage(["A"], 1)).toBe("Apply 1 fix from ocra and 1 suggestion");
  });
});

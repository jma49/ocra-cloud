import { expect, it } from "vitest";
import { parsePatch } from "./diff.js";
import { chunksOf, linesOfRow, rowsOf } from "./diff-rows.js";

const lines = parsePatch(["@@ -1,4 +1,4 @@", " a", "-b", "-c", "+B", " d", "+e"].join("\n"));

it("draws each line on its own row, unified", () => {
  expect(rowsOf(lines, "unified").map((r) => (r.kind === "pair" ? -1 : r.line))).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ]);
});

it("sets a removed line beside the added line that took its place, split", () => {
  expect(rowsOf(lines, "split")).toEqual([
    { kind: "hunk", line: 0 },
    { kind: "pair", left: 1, right: 1 },
    { kind: "pair", left: 2, right: 4 },
    { kind: "pair", left: 3, right: null },
    { kind: "pair", left: 5, right: 5 },
    { kind: "pair", left: null, right: 6 },
  ]);
});

it("names a context line once and each side of a changed pair", () => {
  expect(linesOfRow({ kind: "pair", left: 1, right: 1 })).toEqual([1]);
  expect(linesOfRow({ kind: "pair", left: 2, right: 4 })).toEqual([2, 4]);
  expect(linesOfRow({ kind: "pair", left: null, right: 6 })).toEqual([6]);
});

it("cuts rows into runs, the last one shorter", () => {
  expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

import { expect, it } from "vitest";
import { parsePatch } from "./diff.js";
import { findInDiffs, MAX_MATCHES, rangesByFile } from "./diff-search.js";

const file = (path: string, ...lines: string[]) => ({
  path,
  lines: parsePatch(["@@ -1,9 +1,9 @@ Refund refund", ...lines].join("\n")),
});

it("finds every place in every file, ignoring case, but not in hunk heads", () => {
  const matches = findInDiffs(
    [
      file("a.ts", " const refund = 1;", "-Refund(refund)"),
      file("b.ts", "+no match"),
      file("c.ts", "+REFUND"),
    ],
    "refund",
  );
  expect(matches).toEqual([
    { path: "a.ts", line: 1, from: 6, to: 12 },
    { path: "a.ts", line: 2, from: 0, to: 6 },
    { path: "a.ts", line: 2, from: 7, to: 13 },
    { path: "c.ts", line: 1, from: 0, to: 6 },
  ]);
  expect(rangesByFile(matches).get("a.ts")?.get(2)).toEqual([
    { from: 0, to: 6 },
    { from: 7, to: 13 },
  ]);
});

it("finds nothing for an empty query, and stops counting at the cap", () => {
  expect(findInDiffs([file("a.ts", "+a")], "")).toEqual([]);
  const many = file("a.ts", ...Array.from({ length: 3000 }, () => "+aa aa"));
  expect(findInDiffs([many], "a")).toHaveLength(MAX_MATCHES);
});

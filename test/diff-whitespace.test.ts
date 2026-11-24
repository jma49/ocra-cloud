import { describe, expect, it } from "vitest";
import { changeCounts, ignoreWhitespace } from "../src/diff-whitespace.js";

// The diff with whitespace-only changes taken out keeps every line's numbers,
// so what is anchored to a line still finds it.

const patch = (...lines: string[]) => lines.join("\n");

describe("a diff without whitespace changes", () => {
  it("leaves out a hunk that only re-indents", () => {
    const reindent = patch(
      "@@ -1,4 +1,4 @@ function cap()",
      " if (a) {",
      "-return 1;",
      "-}",
      "+  return 1;",
      "+  }",
      " end",
    );
    expect(ignoreWhitespace(reindent)).toBe("");
  });

  it("leaves out trailing whitespace and CRLF, keeping what else changed", () => {
    const mixed = patch(
      "@@ -10,4 +10,4 @@",
      " keep\r",
      "-one  \r",
      "-two\r",
      "+one\r",
      "+TWO\r",
      " keep\r",
    );
    expect(ignoreWhitespace(mixed)).toBe(
      patch("@@ -10,4 +10,4 @@", " keep\r", " one\r", "-two\r", "+TWO\r", " keep\r"),
    );
    expect(ignoreWhitespace(patch("@@ -1,2 +1,2 @@", "-a\r", "-b", "+a", "+b "))).toBe("");
  });

  it("cuts a mixed hunk to the lines around what still changes, with their numbers", () => {
    const old = Array.from({ length: 12 }, (_, i) => `-x${i}`);
    const now = Array.from({ length: 12 }, (_, i) => (i === 10 ? "+  y10" : `+  x${i}`));
    const out = ignoreWhitespace(patch("@@ -5,13 +5,14 @@ head", ...old, "+added", ...now, " z"));
    // x0..x9 only re-indent: the added line at the top and x10's change stay, 3 lines around each.
    expect(out).toBe(
      patch(
        "@@ -5,3 +5,4 @@ head",
        "+added",
        "   x0",
        "   x1",
        "   x2",
        "@@ -12,6 +13,6 @@",
        "   x7",
        "   x8",
        "   x9",
        "-x10",
        "+  y10",
        "   x11",
        " z",
      ),
    );
  });

  it("keeps a real change as it was, with its end-of-file mark", () => {
    const real = patch("@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b");
    expect(ignoreWhitespace(real)).toBe("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b");
  });

  it("writes a side without lines as git does", () => {
    expect(ignoreWhitespace(patch("@@ -0,0 +1,2 @@", "+a", "+b"))).toBe(
      patch("@@ -0,0 +1,2 @@", "+a", "+b"),
    );
    expect(ignoreWhitespace(patch("@@ -5,0 +6,1 @@", "+a"))).toBe(patch("@@ -5,0 +6,1 @@", "+a"));
    expect(ignoreWhitespace(patch("@@ -3,2 +2,0 @@", "-a", "-b"))).toBe(
      patch("@@ -3,2 +2,0 @@", "-a", "-b"),
    );
  });

  it("joins changes close together into one hunk, and keeps hunks apart as they were", () => {
    const two = patch(
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -20,3 +20,3 @@ fn",
      " d",
      "-  e",
      "+e",
      " f",
    );
    expect(ignoreWhitespace(two)).toBe(patch("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"));
  });
});

describe("a diff's counts", () => {
  it("counts the lines each hunk adds and removes, and nothing before the first", () => {
    expect(
      changeCounts(
        patch("@@ -1,2 +1,3 @@", " a", "-b", "+B", "+c", "\\ No newline at end of file"),
      ),
    ).toEqual({ additions: 2, deletions: 1 });
    expect(changeCounts(patch("--- a/x", "+++ b/x", "@@ -3 +3 @@", "-x", "+y"))).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(changeCounts("")).toEqual({ additions: 0, deletions: 0 });
  });
});

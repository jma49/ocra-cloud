import { describe, expect, it } from "vitest";
import { anchorOf, parsePatch } from "./diff.js";

const PATCH = [
  "@@ -10,4 +10,5 @@ export function refund(",
  " const left = charge.captured;",
  "-if (amount > charge.amount) {",
  "+if (amount > left) {",
  "+  log(amount);",
  "   throw new RefundTooLarge(amount);",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("a file's diff", () => {
  it("numbers each line on its side, and leaves out what is not a line of the file", () => {
    const lines = parsePatch(PATCH);
    expect(
      lines.map((l) => [l.kind, "old" in l ? l.old : null, "new" in l ? l.new : null]),
    ).toEqual([
      ["hunk", null, null],
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
  });

  it("anchors a comment on a removed line to the old side, any other to the new", () => {
    const [hunk, context, del, add] = parsePatch(PATCH);
    expect(hunk && anchorOf(hunk)).toBeNull();
    expect(context && anchorOf(context)).toEqual({ line: 10, side: "new" });
    expect(del && anchorOf(del)).toEqual({ line: 11, side: "old" });
    expect(add && anchorOf(add)).toEqual({ line: 11, side: "new" });
  });
});

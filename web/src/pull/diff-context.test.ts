import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff.js";
import {
  clampShown,
  gapsOf,
  NOTHING_REVEALED,
  type Revealed,
  revealStep,
  withContext,
} from "./diff-context.js";

// Two hunks: new lines 10-12 and 50-51, the old side two lines ahead after the first.
const lines = parsePatch(
  ["@@ -10,2 +10,3 @@ fn a", " a", "+b", " c", "@@ -48,2 +50,2 @@ fn b", "-d", "+D", " e"].join(
    "\n",
  ),
);
const fileLines = (from: number, to: number) =>
  new Map(Array.from({ length: to - from + 1 }, (_, i) => [from + i, `line ${from + i}`]));

describe("gaps", () => {
  it("finds the lines left out before each hunk and after the last, with the old side's offset", () => {
    expect(gapsOf(lines)).toEqual([
      { key: 0, from: 1, to: 9, delta: 0 },
      { key: 1, from: 13, to: 49, delta: -2 },
      { key: 2, from: 52, to: null, delta: -2 },
    ]);
  });
});

describe("revealing", () => {
  const gaps = gapsOf(lines);
  const gap = (k: number) => {
    const found = gaps[k];
    if (!found) throw new Error(`no gap ${k}`);
    return found;
  };
  const at = (r: Revealed) => withContext(lines, gaps, r);

  it("opens a short gap whole, and a long one a step at a time from either end", () => {
    expect(revealStep(gap(0), NOTHING_REVEALED, "up")).toEqual({
      from: 1,
      to: 9,
      shown: { top: 9, bottom: 0 },
    });
    expect(revealStep(gap(1), NOTHING_REVEALED, "up")).toEqual({
      from: 30,
      to: 49,
      shown: { top: 0, bottom: 20 },
    });
    expect(revealStep(gap(1), NOTHING_REVEALED, "down")).toEqual({
      from: 13,
      to: 32,
      shown: { top: 20, bottom: 0 },
    });
    expect(revealStep(gap(2), NOTHING_REVEALED, "all")).toEqual({
      from: 52,
      to: 71,
      shown: { top: 20, bottom: 0 },
    });
  });

  it("puts revealed lines next to their hunks, numbered on both sides", () => {
    const r: Revealed = {
      known: fileLines(13, 49),
      total: null,
      shown: new Map([[1, { top: 2, bottom: 1 }]]),
    };
    const { lines: shown, open } = at(r);
    const texts = shown.map((l) =>
      l.kind === "hunk" ? "@@" : `${l.kind === "context" ? l.old : ""}:${l.text}`,
    );
    expect(texts).toEqual([
      "@@",
      "10:a",
      ":b",
      "11:c",
      "11:line 13",
      "12:line 14",
      "@@",
      "47:line 49",
      ":d",
      ":D",
      "49:e",
      "@@",
    ]);
    expect([...open.values()].map((o) => [o.gap.key, o.hidden])).toEqual([
      [0, 9],
      [1, 34],
      [2, null],
    ]);
  });

  it("drops a hunk's head once the gap above it is all open, and the end's row once the file ends", () => {
    const r: Revealed = {
      known: fileLines(1, 60),
      total: 53,
      shown: new Map([
        [0, { top: 9, bottom: 0 }],
        [2, clampShown(gap(2), { top: 20, bottom: 0 }, 53)],
      ]),
    };
    const { lines: shown, open } = at(r);
    expect(shown.filter((l) => l.kind === "hunk")).toHaveLength(1);
    expect(shown.at(-1)).toMatchObject({ kind: "context", new: 53, old: 51 });
    expect([...open.values()].map((o) => o.gap.key)).toEqual([1]);
  });
});

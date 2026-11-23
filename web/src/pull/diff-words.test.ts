import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff.js";
import { changedWords, markRuns, wordChanges } from "./diff-words.js";

const cut = (text: string, ranges: { from: number; to: number }[]) =>
  ranges.map((r) => text.slice(r.from, r.to));

describe("changed words", () => {
  it("marks only the words that differ on each side", () => {
    const before = "if (amount > charge.captured) {";
    const after = "if (amount > left) {";
    const r = changedWords(before, after);
    expect(cut(before, r?.before ?? [])).toEqual(["charge.captured"]);
    expect(cut(after, r?.after ?? [])).toEqual(["left"]);
  });

  it("joins two changed words across the blank between them", () => {
    const before = "const a = one two;";
    const after = "const a = three four;";
    expect(cut(after, changedWords(before, after)?.after ?? [])).toEqual(["three four"]);
  });

  it("leaves a rewritten line, an unchanged one and a very long one whole", () => {
    expect(changedWords("return charge;", "await ledger.post(entry, now);")).toBeNull();
    expect(changedWords("same", "same")).toBeNull();
    expect(changedWords("x".repeat(600), `${"x".repeat(600)}y`)).toBeNull();
  });

  it("pairs a run of removed lines with the added lines after it, in order", () => {
    const lines = parsePatch(
      [
        "@@ -1,4 +1,4 @@",
        " keep",
        "-let a = 1;",
        "-let b = 2;",
        "+let a = 10;",
        "+let b = 20;",
        " end",
      ].join("\n"),
    );
    const marks = wordChanges(lines);
    expect([...marks.keys()].sort()).toEqual([2, 3, 4, 5]);
    expect(cut(lines[4]?.text ?? "", marks.get(4) ?? [])).toEqual(["10"]);
    expect(cut(lines[3]?.text ?? "", marks.get(3) ?? [])).toEqual(["2"]);
  });

  it("does not pair an added line that follows no removed one", () => {
    const lines = parsePatch(["@@ -1,1 +1,2 @@", " keep", "+let a = 1;"].join("\n"));
    expect(wordChanges(lines).size).toBe(0);
  });
});

describe("marked runs", () => {
  it("cuts a coloured run where a change starts and ends, keeping its colour", () => {
    const runs = [
      { text: "const ", kind: "keyword" },
      { text: "left = 1", kind: null },
    ];
    expect(markRuns(runs, [{ from: 6, to: 10 }])).toEqual([
      { text: "const ", kind: "keyword", changed: false },
      { text: "left", kind: null, changed: true },
      { text: " = 1", kind: null, changed: false },
    ]);
  });

  it("gives the runs back unmarked when nothing changed", () => {
    expect(markRuns([{ text: "a", kind: null }], undefined)).toEqual([
      { text: "a", kind: null, changed: false },
    ]);
  });
});

import type { CodeGraph } from "@open-cr-agent/code-graph";
import { describe, expect, it } from "vitest";
import { impactOf, MAX_USES, withCode } from "../src/graph/impact.js";
import { type ChangedFile, type Hunk, hunksOf } from "../src/platforms/changes.js";

// A pull request's impact from hunk headers and the base side's graph: which
// definitions changed, how, and where the rest of the repository uses them.

type Def = {
  name: string;
  kind: "function" | "method" | "class";
  startLine: number;
  endLine: number;
};
type Source = { definitions: Def[]; uses?: Record<string, number[]> };

function graphOf(files: Record<string, Source>): CodeGraph {
  return {
    parser: "test",
    files: new Map(Object.keys(files).map((p) => [p, `typescript:${p}`])),
    symbols: new Map(
      Object.entries(files).map(([p, s]) => [
        `typescript:${p}`,
        { definitions: s.definitions, uses: new Map(Object.entries(s.uses ?? {})) },
      ]),
    ),
  };
}

const hunk = (
  oldStart: number,
  oldLines: number,
  newStart = oldStart,
  newLines = oldLines,
): Hunk => ({
  oldStart,
  oldLines,
  newStart,
  newLines,
});
const modified = (path: string, ...hunks: Hunk[]): ChangedFile => ({
  path,
  oldPath: path,
  status: "modified",
  hunks,
});

const money = graphOf({
  "src/money/parse.ts": {
    definitions: [{ name: "parseAmount", kind: "function", startLine: 12, endLine: 38 }],
  },
  "src/refund/limits.ts": {
    definitions: [{ name: "refundCap", kind: "function", startLine: 22, endLine: 40 }],
    uses: { parseAmount: [27] },
  },
  "src/api/quotes.ts": {
    definitions: [
      { name: "Quotes", kind: "class", startLine: 1, endLine: 120 },
      { name: "createQuote", kind: "method", startLine: 80, endLine: 100 },
    ],
    uses: { parseAmount: [88, 3] },
  },
  "src/checkout/total.ts": {
    definitions: [{ name: "cartTotal", kind: "function", startLine: 30, endLine: 50 }],
    uses: { parseAmount: [41] },
  },
});

describe("hunk headers", () => {
  it("read every header, with a count of 1 where it is left out", () => {
    const patch =
      "@@ -12,3 +12,4 @@ function a\n-x\n+y\n+z\n context @@ -1 +1 @@\n@@ -40 +41,0 @@\n-gone";
    expect(hunksOf(patch)).toEqual([hunk(12, 3, 12, 4), hunk(40, 1, 41, 0)]);
  });
});

describe("a changed symbol", () => {
  it("is the definition a hunk's old lines sit in, with the hunk's head-side lines", () => {
    const { symbols } = impactOf(money, [modified("src/money/parse.ts", hunk(31, 1, 31, 1))]);
    expect(symbols).toMatchObject([
      {
        name: "parseAmount",
        kind: "function",
        path: "src/money/parse.ts",
        startLine: 12,
        endLine: 38,
        change: "body",
        lines: [[31, 31]],
      },
    ]);
  });

  it("changes its signature when a hunk touches its first line, or its file is deleted", () => {
    expect(
      impactOf(money, [modified("src/money/parse.ts", hunk(10, 3, 10, 3))]).symbols[0]?.change,
    ).toBe("signature");
    const removed = impactOf(money, [
      { path: "src/money/parse.ts", oldPath: "src/money/parse.ts", status: "removed", hunks: null },
    ]);
    expect(removed.symbols).toMatchObject([
      { name: "parseAmount", change: "signature", lines: [] },
    ]);
  });

  it("is untouched by lines added after its last line, and changed by lines added inside it", () => {
    expect(impactOf(money, [modified("src/money/parse.ts", hunk(38, 0, 39, 4))]).symbols).toEqual(
      [],
    );
    expect(
      impactOf(money, [modified("src/money/parse.ts", hunk(20, 0, 21, 2))]).symbols,
    ).toMatchObject([{ name: "parseAmount", change: "body", lines: [[21, 22]] }]);
  });

  it("is the innermost definition: a method's change is not its class's", () => {
    const { symbols } = impactOf(money, [modified("src/api/quotes.ts", hunk(90, 2))]);
    expect(symbols.map((s) => s.name)).toEqual(["createQuote"]);
  });

  it("is read on the base side of a renamed file, and none comes from an added one", () => {
    const renamed: ChangedFile = {
      path: "src/money/read.ts",
      oldPath: "src/money/parse.ts",
      status: "renamed",
      hunks: [hunk(14, 1)],
    };
    const added: ChangedFile = {
      path: "src/new.ts",
      oldPath: "src/new.ts",
      status: "added",
      hunks: [hunk(0, 0, 1, 9)],
    };
    const { symbols } = impactOf(money, [renamed, added]);
    expect(symbols).toMatchObject([{ name: "parseAmount", path: "src/money/parse.ts" }]);
  });

  it("is not guessed for a file the platform sent no diff for", () => {
    const { symbols } = impactOf(money, [{ ...modified("src/money/parse.ts"), hunks: null }]);
    expect(symbols).toEqual([]);
  });
});

describe("a changed symbol's uses", () => {
  it("are the other files' uses of its name, with the definition each sits in, outside the pull request", () => {
    const { symbols } = impactOf(money, [
      modified("src/money/parse.ts", hunk(31, 1)),
      modified("src/checkout/total.ts", hunk(41, 1)),
    ]);
    const parse = symbols.find((s) => s.name === "parseAmount");
    expect(parse?.uses).toEqual([
      { path: "src/api/quotes.ts", line: 3, within: "Quotes", code: null },
      { path: "src/api/quotes.ts", line: 88, within: "createQuote", code: null },
      { path: "src/refund/limits.ts", line: 27, within: "refundCap", code: null },
    ]);
    expect(parse).toMatchObject({ useCount: 3, fileCount: 2 });
  });

  it("leave out another file's definition of the same name", () => {
    const graph = graphOf({
      "a.ts": { definitions: [{ name: "load", kind: "function", startLine: 1, endLine: 5 }] },
      "b.ts": {
        definitions: [{ name: "load", kind: "function", startLine: 3, endLine: 9 }],
        uses: { load: [3, 12] },
      },
    });
    const { symbols } = impactOf(graph, [modified("a.ts", hunk(2, 1))]);
    expect(symbols[0]?.uses.map((u) => u.line)).toEqual([12]);
  });

  it(`are listed up to ${MAX_USES}, and all counted`, () => {
    const lines = Array.from({ length: MAX_USES + 5 }, (_, i) => i + 1);
    const graph = graphOf({
      "a.ts": { definitions: [{ name: "hot", kind: "function", startLine: 1, endLine: 5 }] },
      "b.ts": { definitions: [], uses: { hot: lines } },
    });
    const [hot] = impactOf(graph, [modified("a.ts", hunk(2, 1))]).symbols;
    expect(hot?.uses).toHaveLength(MAX_USES);
    expect(hot?.useCount).toBe(MAX_USES + 5);
  });

  it("order the symbols: signature changes first, then the most used", () => {
    const graph = graphOf({
      "a.ts": {
        definitions: [
          { name: "quiet", kind: "function", startLine: 1, endLine: 5 },
          { name: "busy", kind: "function", startLine: 10, endLine: 20 },
          { name: "renamedParam", kind: "function", startLine: 30, endLine: 40 },
        ],
      },
      "b.ts": { definitions: [], uses: { busy: [1, 2, 3], quiet: [4], renamedParam: [5] } },
    });
    const { symbols } = impactOf(graph, [modified("a.ts", hunk(2, 1), hunk(12, 1), hunk(30, 1))]);
    expect(symbols.map((s) => s.name)).toEqual(["renamedParam", "busy", "quiet"]);
  });
});

describe("the code of the uses shown", () => {
  it("is read once per file for the first uses only, and stays null where unreadable", async () => {
    const { symbols } = impactOf(money, [modified("src/money/parse.ts", hunk(31, 1))]);
    const reads: string[] = [];
    const text: Record<string, string[]> = {
      "src/api/quotes.ts": Array.from({ length: 90 }, (_, i) => `line ${i + 1}  `),
    };
    await withCode(symbols, 2, async (path) => {
      reads.push(path);
      return text[path];
    });
    expect(reads).toEqual(["src/api/quotes.ts"]);
    expect(symbols[0]?.uses.map((u) => u.code)).toEqual(["line 3", "line 88", null, null]);
  });
});

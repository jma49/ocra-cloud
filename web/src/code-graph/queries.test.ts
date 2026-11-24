import { describe, expect, it } from "vitest";
import { layoutMap } from "./layout.js";
import { buildModel, type Model } from "./model.js";
import { focusFile, focusSymbol, locate, mapOf, search } from "./queries.js";

type Defs = [string, string, number, number][];
type Uses = [string, number[]][];

function graph(files: Record<string, { defs?: Defs; uses?: Uses }>): Model {
  const entries = Object.entries(files);
  const text = JSON.stringify({
    format: 1,
    parser: "test",
    files: entries.map(([path], i) => [path, `k${i}`]),
    symbols: entries.map(([, s], i) => [
      `k${i}`,
      { definitions: s.defs ?? [], uses: s.uses ?? [] },
    ]),
  });
  const model = buildModel(text, "c".repeat(40));
  if (!model) throw new Error("not a graph");
  return model;
}

const repo = () =>
  graph({
    "src/api/routes.ts": {
      defs: [["handle", "function", 3, 20]],
      uses: [
        ["handle", [3]],
        ["chargeCard", [8, 12]],
        ["logLine", [15]],
      ],
    },
    "src/billing/charge.ts": {
      defs: [
        ["chargeCard", "function", 1, 30],
        ["round", "function", 32, 36],
      ],
      uses: [
        ["chargeCard", [1]],
        ["round", [10, 32]],
        ["logLine", [20]],
      ],
    },
    "src/util/log.ts": { defs: [["logLine", "function", 1, 4]], uses: [["logLine", [1]]] },
    "README.md": {},
  });

describe("the explorer's model", () => {
  it("refuses text that is not a stored graph", () => {
    expect(buildModel("{", "")).toBeUndefined();
    expect(buildModel(JSON.stringify({ format: 2, files: [], symbols: [] }), "")).toBeUndefined();
  });

  it("joins files by the names one uses and another defines, its own definitions left out", () => {
    const m = repo();
    const routes = m.files.indexOf("src/api/routes.ts");
    const charge = m.files.indexOf("src/billing/charge.ts");
    const log = m.files.indexOf("src/util/log.ts");
    expect(Object.fromEntries(m.fileOut[routes] ?? [])).toEqual({ [charge]: 2, [log]: 1 });
    expect(Object.fromEntries(m.fileIn[log] ?? [])).toEqual({ [routes]: 1, [charge]: 1 });
    expect(m.fileOut[log]?.size).toBe(0);
  });

  it("joins no files through a one-word name or a camelCase variable, which are mostly fields", () => {
    const m = graph({
      "a.ts": {
        defs: [
          ["status", "function", 1, 2],
          ["runId", "variable", 3, 3],
          ["MAX_RUNS", "variable", 4, 4],
        ],
      },
      "b.ts": {
        uses: [
          ["status", [5]],
          ["runId", [6]],
          ["MAX_RUNS", [7]],
        ],
      },
    });
    expect(Object.fromEntries(m.fileOut[m.files.indexOf("b.ts")] ?? [])).toEqual({
      [m.files.indexOf("a.ts")]: 1,
    });
    const status = locate(m, "a.ts", { name: "status" })?.def ?? -1;
    expect(focusSymbol(m, status).callers).toHaveLength(1);
  });

  it("joins no files through a name that too many files define", () => {
    const files: Record<string, { defs?: Defs; uses?: Uses }> = {
      "use.ts": { uses: [["getValue", [2]]] },
    };
    for (let i = 0; i < 5; i++) files[`def${i}.ts`] = { defs: [["getValue", "method", 1, 2]] };
    const m = graph(files);
    expect(m.fileOut[m.files.indexOf("use.ts")]?.size).toBe(0);
  });
});

describe("a folder's map", () => {
  it("draws the children of a lone top folder, with the uses between them", () => {
    const view = mapOf(repo(), "");
    expect(view.folder).toBe("");
    expect(view.nodes.map((n) => [n.path, n.kind])).toEqual([
      ["README.md", "file"],
      ["src", "folder"],
    ]);
    const src = mapOf(repo(), "src");
    expect(src.nodes.map((n) => n.label)).toEqual(["api", "billing", "util"]);
    expect(src.edges).toEqual([
      { from: "src/api", to: "src/billing", weight: 2 },
      { from: "src/api", to: "src/util", weight: 1 },
      { from: "src/billing", to: "src/util", weight: 1 },
    ]);
  });

  it("joins a chain of lone folders into one node and goes into a folder that is all there is", () => {
    const m = graph({ "pkg/core/src/a.ts": {}, "pkg/core/src/b.ts": {}, "pkg/cli/main.ts": {} });
    const view = mapOf(m, "");
    expect(view.folder).toBe("pkg");
    expect(view.nodes.map((n) => n.label)).toEqual(["cli", "core/src"]);
    expect(view.nodes.map((n) => n.files)).toEqual([1, 2]);
  });

  it("counts the uses that cross the folder's edge", () => {
    const api = mapOf(repo(), "src/api");
    expect(api.nodes).toEqual([
      expect.objectContaining({ path: "src/api/routes.ts", usesOutside: 3, usedFromOutside: 0 }),
    ]);
  });

  it("lays every node out, the same way each time", () => {
    const view = mapOf(repo(), "src");
    const once = layoutMap(view);
    expect(once.map((p) => p.path)).toEqual(view.nodes.map((n) => n.path));
    expect(once.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(layoutMap(view)).toEqual(once);
  });
});

describe("a focus", () => {
  it("lists a file's symbols and the files on each side of it", () => {
    const m = repo();
    const f = focusFile(m, m.files.indexOf("src/billing/charge.ts"));
    expect(f.defs.map((d) => d.name)).toEqual(["chargeCard", "round"]);
    expect(f.callers).toEqual([{ as: "file", path: "src/api/routes.ts", weight: 2 }]);
    expect(f.callees).toEqual([{ as: "file", path: "src/util/log.ts", weight: 1 }]);
  });

  it("finds a symbol's callers by the definition each use sits in, and what it calls", () => {
    const m = repo();
    const at = locate(m, "src/billing/charge.ts", { name: "chargeCard", line: 1 });
    expect(at?.def).toBeDefined();
    const f = focusSymbol(m, at?.def ?? -1);
    expect(f.symbol).toMatchObject({ name: "chargeCard", path: "src/billing/charge.ts", start: 1 });
    expect(f.callers).toEqual([
      expect.objectContaining({
        as: "symbol",
        symbol: expect.objectContaining({ name: "handle" }),
        weight: 2,
        lines: [8, 12],
      }),
    ]);
    expect(f.callees.map((c) => c.as === "symbol" && c.symbol.name)).toEqual(["round", "logLine"]);
    expect(f.namesakes).toBe(1);
  });

  it("puts a use outside every definition at its file's top level", () => {
    const m = graph({
      "a.ts": { defs: [["run", "function", 1, 3]] },
      "b.ts": { uses: [["run", [7]]] },
    });
    const f = focusSymbol(m, locate(m, "a.ts", { name: "run" })?.def ?? -1);
    expect(f.callers).toEqual([{ as: "top", path: "b.ts", weight: 1, lines: [7] }]);
  });

  it("answers nothing for a path the graph does not hold", () => {
    expect(locate(repo(), "gone.ts")).toBeUndefined();
  });
});

describe("the search", () => {
  it("puts an exact name first, then names and files that start with the query", () => {
    const hits = search(repo(), "charge");
    expect(hits[0]).toMatchObject({ as: "symbol", symbol: { name: "chargeCard" } });
    expect(hits.some((h) => h.as === "file" && h.path === "src/billing/charge.ts")).toBe(true);
    expect(search(repo(), "  ")).toEqual([]);
  });
});

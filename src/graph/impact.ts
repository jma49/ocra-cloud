import type { CodeGraph } from "@open-cr-agent/code-graph";
import type { ChangedFile, Hunk, PullChanges } from "../platforms/changes.js";
import type { ImpactSymbol, ImpactUse, ImpactView } from "../shared/index.js";

// The impact of a pull request on the base side's graph, without its code:
// a definition is changed when a hunk's old range has a line whose innermost
// definition it is, as the engine's impact analysis decides on its side;
// its uses are the other files' identifiers of that name.

type FileSymbols = NonNullable<ReturnType<CodeGraph["symbols"]["get"]>>;
type Definition = FileSymbols["definitions"][number];

export const MAX_SYMBOLS = 60;
export const MAX_USES = 200;
/** Old lines looked at per hunk: a larger one is a rewrite, and its first lines decide. */
const MAX_HUNK_LINES = 2000;
const IGNORED = new Set(["constructor"]);
const READS_AT_ONCE = 8;

type Changed = { def: Definition; path: string; signature: boolean; lines: [number, number][] };

export type Impact = { symbols: ImpactSymbol[]; more: number };

export function impactOf(graph: CodeGraph, files: readonly ChangedFile[]): Impact {
  const changed = new Map<string, Changed>();
  const mark = (path: string, def: Definition, signature: boolean, hunk?: Hunk) => {
    const key = `${path}\0${def.startLine}\0${def.name}`;
    const seen = changed.get(key) ?? { def, path, signature: false, lines: [] };
    seen.signature ||= signature;
    if (hunk) {
      const range = newRange(hunk);
      if (!seen.lines.some(([a, b]) => a === range[0] && b === range[1])) seen.lines.push(range);
    }
    changed.set(key, seen);
  };
  for (const file of files) {
    if (file.status === "added") continue;
    const defs = symbolsOf(graph, file.oldPath)?.definitions;
    if (!defs) continue;
    if (file.status === "removed") {
      for (const def of defs) mark(file.oldPath, def, true);
      continue;
    }
    for (const hunk of file.hunks ?? []) {
      for (const line of oldLines(hunk)) {
        const def = innermost(defs, line, hunk.oldLines === 0);
        if (def) mark(file.oldPath, def, line === def.startLine && hunk.oldLines > 0, hunk);
      }
    }
  }
  const own = new Set(files.flatMap((f) => [f.path, f.oldPath]));
  const symbols = [...changed.values()]
    .filter(({ def }) => !IGNORED.has(def.name))
    .map((c) => symbolOf(graph, c, own))
    .sort(
      (a, b) =>
        Number(b.change === "signature") - Number(a.change === "signature") ||
        b.useCount - a.useCount ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    );
  return {
    symbols: symbols.slice(0, MAX_SYMBOLS),
    more: Math.max(0, symbols.length - MAX_SYMBOLS),
  };
}

function symbolOf(graph: CodeGraph, c: Changed, own: ReadonlySet<string>): ImpactSymbol {
  const uses: Omit<ImpactUse, "code">[] = [];
  for (const [path, key] of graph.files) {
    if (own.has(path)) continue;
    const symbols = graph.symbols.get(key);
    const lines = symbols?.uses.get(c.def.name);
    if (!symbols || !lines) continue;
    for (const line of lines) {
      // The line that defines another symbol of the same name is not a use.
      if (symbols.definitions.some((d) => d.name === c.def.name && d.startLine === line)) continue;
      uses.push({ path, line, within: innermost(symbols.definitions, line, false)?.name ?? null });
    }
  }
  uses.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return {
    name: c.def.name,
    kind: c.def.kind,
    path: c.path,
    startLine: c.def.startLine,
    endLine: c.def.endLine,
    change: c.signature ? "signature" : "body",
    lines: c.lines.sort((a, b) => a[0] - b[0]),
    uses: uses.slice(0, MAX_USES).map((u) => ({ ...u, code: null })),
    useCount: uses.length,
    fileCount: new Set(uses.map((u) => u.path)).size,
  };
}

/** Uses whose code line an answer reads, from at most as many files. */
export const CODE_LINES = 40;
/** A file larger than this is not read for its uses' lines. */
export const MAX_FILE_BYTES = 1_000_000;

export const pullView = (changes: PullChanges): NonNullable<ImpactView["pull"]> => ({
  base: changes.base,
  head: changes.head,
  files: changes.files.length,
  truncated: changes.truncated,
  unread: changes.files.filter((f) => f.hunks === null && f.status === "modified").length,
});

/** The id of a file's blob, from the graph's key of it. */
export function blobIdOf(graph: CodeGraph, path: string): string | undefined {
  const key = graph.files.get(path);
  return key?.slice(key.lastIndexOf(":") + 1);
}

/** Fills the code line of the first `cap` uses, reading each file once; the rest stay null. */
export async function withCode(
  symbols: ImpactSymbol[],
  cap: number,
  read: (path: string) => Promise<readonly string[] | undefined>,
): Promise<ImpactSymbol[]> {
  const shown = symbols.flatMap((s) => s.uses).slice(0, cap);
  const paths = [...new Set(shown.map((u) => u.path))];
  const texts = new Map<string, readonly string[] | undefined>();
  for (let i = 0; i < paths.length; i += READS_AT_ONCE) {
    const batch = paths.slice(i, i + READS_AT_ONCE);
    const lines = await Promise.all(batch.map(read));
    for (const [j, path] of batch.entries()) texts.set(path, lines[j]);
  }
  for (const use of shown) {
    const line = texts.get(use.path)?.[use.line - 1];
    if (line !== undefined) use.code = line.trimEnd().slice(0, 240);
  }
  return symbols;
}

function symbolsOf(graph: CodeGraph, path: string): FileSymbols | undefined {
  const key = graph.files.get(path);
  return key === undefined ? undefined : graph.symbols.get(key);
}

/** The old side's lines a hunk touches; a pure insertion names the line it follows. */
function oldLines(hunk: Hunk): number[] {
  const count = Math.min(Math.max(hunk.oldLines, 1), MAX_HUNK_LINES);
  return Array.from({ length: count }, (_, i) => hunk.oldStart + i);
}

function newRange(hunk: Hunk): [number, number] {
  return [hunk.newStart, hunk.newStart + Math.max(hunk.newLines, 1) - 1];
}

/**
 * The narrowest definition holding the line. After an insertion the line
 * is the one the new lines follow, so a definition's last line does not
 * hold it: lines added after a closing brace are outside.
 */
function innermost(
  defs: readonly Definition[],
  line: number,
  insertion: boolean,
): Definition | undefined {
  let best: Definition | undefined;
  for (const d of defs) {
    const inside = d.startLine <= line && (insertion ? line < d.endLine : line <= d.endLine);
    if (inside && (!best || d.endLine - d.startLine < best.endLine - best.startLine)) best = d;
  }
  return best;
}

import {
  declares,
  definingFiles,
  joinsFiles,
  MAX_NAMESAKE_FILES,
  type Model,
  within,
} from "./model.js";

// What the explorer asks of a model, answered with small plain objects that
// cross from the worker: a folder's map, a file's or a symbol's neighbours,
// a search.

export type MapNode = {
  path: string;
  label: string;
  kind: "folder" | "file";
  files: number;
  defs: number;
  /** Uses of this node's symbols from outside the folder shown, and the other way. */
  usedFromOutside: number;
  usesOutside: number;
};
type MapEdge = { from: string; to: string; weight: number };
export type MapView = {
  folder: string;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Children left off the map, the smallest. */
  hidden: number;
};

const MAX_MAP_NODES = 64;

/** The folder's children (a chain of lone folders as one) and the uses between them. */
export function mapOf(m: Model, folder: string): MapView {
  const prefix = folder === "" ? "" : `${folder}/`;
  const under = m.files
    .map((path, file) => ({ path, file }))
    .filter((f) => f.path.startsWith(prefix));
  const childOf = new Map<number, string>();
  const nodes = new Map<string, MapNode>();
  for (const key of childKeys(under.map((f) => f.path.slice(prefix.length)))) {
    const path = prefix + key.name;
    nodes.set(path, {
      path,
      label: key.name,
      kind: key.folder ? "folder" : "file",
      files: 0,
      defs: 0,
      usedFromOutside: 0,
      usesOutside: 0,
    });
  }
  // A child's first part names it: a joined chain of folders starts with its first.
  const byHead = new Map([...nodes.values()].map((n) => [n.label.split("/")[0] ?? "", n.path]));
  for (const f of under) {
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const child = byHead.get(slash < 0 ? rest : rest.slice(0, slash));
    if (child === undefined) continue;
    childOf.set(f.file, child);
    const node = nodes.get(child);
    if (!node) continue;
    node.files += 1;
    node.defs += m.defsOfFile[f.file]?.length ?? 0;
  }
  if (nodes.size === 1) {
    const only = [...nodes.values()][0];
    if (only?.kind === "folder") return mapOf(m, only.path);
  }

  const weights = new Map<string, number>();
  for (const [from, child] of childOf) {
    for (const [to, n] of m.fileOut[from] ?? []) {
      const target = childOf.get(to);
      if (target === undefined) {
        const node = nodes.get(child);
        if (node) node.usesOutside += n;
        continue;
      }
      if (target === child) continue;
      const key = `${child}\n${target}`;
      weights.set(key, (weights.get(key) ?? 0) + n);
    }
    for (const [by, n] of m.fileIn[from] ?? []) {
      if (childOf.has(by)) continue;
      const node = nodes.get(child);
      if (node) node.usedFromOutside += n;
    }
  }

  const degree = new Map<string, number>();
  for (const [key, n] of weights) {
    const [a = "", b = ""] = key.split("\n");
    degree.set(a, (degree.get(a) ?? 0) + n);
    degree.set(b, (degree.get(b) ?? 0) + n);
  }
  const ranked = [...nodes.values()].sort(
    (a, b) =>
      b.defs + (degree.get(b.path) ?? 0) - (a.defs + (degree.get(a.path) ?? 0)) ||
      a.path.localeCompare(b.path),
  );
  const kept = ranked.slice(0, MAX_MAP_NODES);
  const shown = new Set(kept.map((n) => n.path));
  const edges: MapEdge[] = [];
  for (const [key, weight] of weights) {
    const [from = "", to = ""] = key.split("\n");
    if (shown.has(from) && shown.has(to)) edges.push({ from, to, weight });
  }
  edges.sort((a, b) => b.weight - a.weight);
  return {
    folder,
    nodes: kept.sort((a, b) => a.path.localeCompare(b.path)),
    edges,
    hidden: nodes.size - kept.length,
  };
}

/** The first level under a folder, a folder holding only one folder joined with it. */
function childKeys(rests: string[]): { name: string; folder: boolean }[] {
  const groups = new Map<string, string[]>();
  const files: string[] = [];
  for (const rest of rests) {
    const slash = rest.indexOf("/");
    if (slash < 0) files.push(rest);
    else {
      const head = rest.slice(0, slash);
      const list = groups.get(head) ?? [];
      list.push(rest.slice(slash + 1));
      groups.set(head, list);
    }
  }
  const out = files.map((name) => ({ name, folder: false }));
  for (const [head, inner] of groups) {
    let name = head;
    let rest = inner;
    for (;;) {
      const next = childKeys(rest);
      const only = next.length === 1 ? next[0] : undefined;
      if (!only?.folder) break;
      name = `${name}/${only.name}`;
      const cut = `${only.name}/`;
      rest = rest.map((r) => r.slice(cut.length));
    }
    out.push({ name, folder: true });
  }
  return out;
}

export type SymbolRef = {
  def: number;
  name: string;
  kind: string;
  path: string;
  start: number;
  end: number;
};

/** A file, a symbol, or a file's top level (uses outside any definition), and how many uses join it. */
export type Neighbour =
  | { as: "file"; path: string; weight: number }
  | { as: "symbol"; symbol: SymbolRef; path: string; weight: number; lines: number[] }
  | { as: "top"; path: string; weight: number; lines: number[] };

export type FileFocus = {
  focus: "file";
  path: string;
  defs: SymbolRef[];
  callers: Neighbour[];
  callees: Neighbour[];
};

export type SymbolFocus = {
  focus: "symbol";
  symbol: SymbolRef;
  /** Files that define a symbol of the same name, this one's included. */
  namesakes: number;
  callers: Neighbour[];
  callees: Neighbour[];
  /** Names it uses that other files define but that are too common, or defined too often, to match. */
  unresolved: number;
};

/** Neighbours listed for one focus; the diagram draws the first few. */
const MAX_NEIGHBOURS = 200;
const MAX_LINES = 8;

const ref = (m: Model, def: number): SymbolRef => {
  const d = m.defs[def];
  return {
    def,
    name: d?.name ?? "",
    kind: d?.kind ?? "",
    path: m.files[d?.file ?? -1] ?? "",
    start: d?.start ?? 0,
    end: d?.end ?? 0,
  };
};

const byWeight = <T extends { weight: number; path: string }>(list: T[]) =>
  list.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path)).slice(0, MAX_NEIGHBOURS);

export function focusFile(m: Model, file: number): FileFocus {
  const files = (map: Map<number, number> | undefined): Neighbour[] =>
    byWeight(
      [...(map ?? [])].map(([f, weight]) => ({
        as: "file" as const,
        path: m.files[f] ?? "",
        weight,
      })),
    );
  return {
    focus: "file",
    path: m.files[file] ?? "",
    defs: (m.defsOfFile[file] ?? []).map((id) => ref(m, id)),
    callers: files(m.fileIn[file]),
    callees: files(m.fileOut[file]),
  };
}

export function focusSymbol(m: Model, def: number): SymbolFocus {
  const d = m.defs[def];
  if (!d) throw new Error("no such symbol");
  const namesakes = new Set((m.defsByName.get(d.name) ?? []).map((id) => m.defs[id]?.file)).size;

  const callers = new Map<string, Neighbour & { lines: number[] }>();
  const symbolAt = (id: number, path: string) => ({
    as: "symbol" as const,
    symbol: ref(m, id),
    path,
    weight: 0,
    lines: [] as number[],
  });
  for (const file of m.usersOfName.get(d.name) ?? []) {
    for (const line of m.uses[file]?.get(d.name) ?? []) {
      if (declares(m, file, d.name, line)) continue;
      if (file === d.file && line >= d.start && line <= d.end) continue;
      const host = within(m, file, line);
      const key = host === undefined ? `top:${file}` : `def:${host}`;
      const entry =
        callers.get(key) ??
        (host === undefined
          ? { as: "top" as const, path: m.files[file] ?? "", weight: 0, lines: [] }
          : symbolAt(host, m.files[file] ?? ""));
      entry.weight += 1;
      if (entry.lines.length < MAX_LINES) entry.lines.push(line);
      callers.set(key, entry);
    }
  }

  const callees = new Map<number, Neighbour & { lines: number[] }>();
  let unresolved = 0;
  for (const [name, lines] of m.uses[d.file] ?? []) {
    const inside = lines.filter((l) => l >= d.start && l <= d.end && !declares(m, d.file, name, l));
    if (inside.length === 0) continue;
    const targets = targetsOf(m, name, d.file).filter((t) => t !== def);
    if (targets.length === 0) {
      if ((m.defsByName.get(name)?.length ?? 0) > 0 && name !== d.name) unresolved += 1;
      continue;
    }
    for (const t of targets) {
      callees.set(t, {
        ...symbolAt(t, m.files[m.defs[t]?.file ?? -1] ?? ""),
        weight: inside.length,
        lines: inside.slice(0, MAX_LINES),
      });
    }
  }
  return {
    focus: "symbol",
    symbol: ref(m, def),
    namesakes,
    callers: byWeight(withoutImports([...callers.values()])),
    callees: byWeight([...callees.values()]),
    unresolved,
  };
}

/**
 * The definitions a use of `name` in `file` may mean: the file's own first,
 * else, for a name distinctive enough to match across files, every file's few.
 */
function targetsOf(m: Model, name: string, file: number): number[] {
  const ids = m.defsByName.get(name) ?? [];
  const local = ids.filter((id) => m.defs[id]?.file === file);
  if (local.length > 0) return local;
  if (!joinsFiles(m, name) || definingFiles(m, name).length === 0) return [];
  return ids.length > MAX_NAMESAKE_FILES * 2 ? [] : ids;
}

/**
 * A file that uses a name inside its definitions names it at its top level
 * only to import it: that line is left out, so the file is listed once, by
 * where it uses the symbol.
 */
function withoutImports(callers: Neighbour[]): Neighbour[] {
  const inside = new Set(callers.filter((c) => c.as === "symbol").map((c) => c.path));
  return callers.filter((c) => c.as !== "top" || !inside.has(c.path));
}

export type Hit =
  | { as: "file"; path: string; defs: number }
  | { as: "symbol"; symbol: SymbolRef; uses: number };

const MAX_HITS = 30;

/** Files and symbols whose name holds the query, the closest matches first. */
export function search(m: Model, query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: { score: number; hit: Hit }[] = [];
  m.files.forEach((path, file) => {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const score = base === q ? 0 : base.startsWith(q) ? 2 : lower.includes(q) ? 4 : -1;
    if (score >= 0)
      scored.push({ score, hit: { as: "file", path, defs: m.defsOfFile[file]?.length ?? 0 } });
  });
  for (const [name, ids] of m.defsByName) {
    const lower = name.toLowerCase();
    const score = lower === q ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 3 : -1;
    if (score < 0) continue;
    const uses = (m.usersOfName.get(name) ?? []).length;
    for (const id of ids.slice(0, MAX_NAMESAKE_FILES)) {
      scored.push({ score, hit: { as: "symbol", symbol: ref(m, id), uses } });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || nameOf(a.hit).length - nameOf(b.hit).length)
    .slice(0, MAX_HITS)
    .map((s) => s.hit);
}

const nameOf = (h: Hit) => (h.as === "file" ? h.path : h.symbol.name);

/** The file and, when named, the symbol an address points at. */
export function locate(
  m: Model,
  path: string,
  symbol?: { name: string; line?: number },
): { file: number; def?: number } | undefined {
  const file = m.files.indexOf(path);
  if (file < 0) return undefined;
  if (!symbol) return { file };
  const own = (m.defsOfFile[file] ?? []).filter((id) => m.defs[id]?.name === symbol.name);
  const def = own.find((id) => m.defs[id]?.start === symbol.line) ?? own[0];
  return def === undefined ? { file } : { file, def };
}

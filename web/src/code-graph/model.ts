// A repository's code graph as the explorer reads it: the engine's stored
// graph (code-graph format 1: per file, its definitions and the lines each
// name is used on), indexed so a folder's map, a file's or a symbol's
// neighbours and a search answer without walking the whole graph again.
// Uses are matched to definitions by name, as the engine matches them.

type Def = {
  file: number;
  name: string;
  kind: string;
  start: number;
  end: number;
};

export type Model = {
  commit: string;
  files: string[];
  defs: Def[];
  /** file → its definitions' ids, by start line */
  defsOfFile: number[][];
  /** file → name → the lines it is used on */
  uses: Map<string, number[]>[];
  defsByName: Map<string, number[]>;
  /** name → the files that use it */
  usersOfName: Map<string, number[]>;
  /** file → file → uses from the first of names the second defines */
  fileOut: Map<number, number>[];
  fileIn: Map<number, number>[];
};

/**
 * A name defined in more files than this is read as many symbols that share
 * a name (`get`, `render`): its uses join no file to another.
 */
export const MAX_NAMESAKE_FILES = 4;

type Stored = {
  format: 1;
  files: [string, string][];
  symbols: [
    string,
    { definitions: [string, string, number, number][]; uses: [string, number[]][] },
  ][];
};

/** The explorer's model of a stored graph's text; undefined for text of another format. */
export function buildModel(text: string, commit: string): Model | undefined {
  let stored: Stored;
  try {
    stored = JSON.parse(text) as Stored;
  } catch {
    return undefined;
  }
  if (stored?.format !== 1 || !Array.isArray(stored.files) || !Array.isArray(stored.symbols))
    return undefined;
  const byKey = new Map(stored.symbols);
  const pairs = [...stored.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const files = pairs.map(([path]) => path);
  const defs: Def[] = [];
  const defsOfFile: number[][] = [];
  const uses: Map<string, number[]>[] = [];
  const defsByName = new Map<string, number[]>();
  const usersOfName = new Map<string, number[]>();

  pairs.forEach(([, key], file) => {
    const symbols = byKey.get(key);
    const own: number[] = [];
    for (const [name, kind, start, end] of symbols?.definitions ?? []) {
      own.push(defs.length);
      push(defsByName, name, defs.length);
      defs.push({ file, name, kind, start, end });
    }
    own.sort((a, b) => (defs[a]?.start ?? 0) - (defs[b]?.start ?? 0));
    defsOfFile.push(own);
    const used = new Map<string, number[]>();
    for (const [name, lines] of symbols?.uses ?? []) {
      used.set(name, lines);
      push(usersOfName, name, file);
    }
    uses.push(used);
  });

  const model: Model = {
    commit,
    files,
    defs,
    defsOfFile,
    uses,
    defsByName,
    usersOfName,
    fileOut: files.map(() => new Map()),
    fileIn: files.map(() => new Map()),
  };
  joinFiles(model);
  return model;
}

/**
 * Whether a name is distinctive enough to join one file to another: a word
 * like `status`, `push` or `id` is mostly a field or a local that happens to
 * share a definition's name, so only names of more than one word (camelCase,
 * snake_case), and capitalised ones (types, constants), join files; a
 * camelCase variable is mostly a field too. A focus on one symbol still
 * lists every use of its name.
 */
export function joinsFiles(m: Model, name: string): boolean {
  if (/^[A-Z]/.test(name)) return true;
  if (!/.[A-Z_0-9]/.test(name)) return false;
  return (m.defsByName.get(name) ?? []).some((id) => m.defs[id]?.kind !== "variable");
}

function joinFiles(m: Model) {
  const defining = new Map<string, number[]>();
  for (const name of m.defsByName.keys()) {
    if (joinsFiles(m, name)) defining.set(name, definingFiles(m, name));
  }
  m.uses.forEach((used, from) => {
    const declared = new Map<string, number[]>();
    for (const id of m.defsOfFile[from] ?? []) {
      const d = m.defs[id];
      if (d) declared.set(d.name, [...(declared.get(d.name) ?? []), d.start]);
    }
    for (const [name, lines] of used) {
      const targets = defining.get(name);
      if (!targets?.length) continue;
      const own = declared.get(name);
      const n = own ? lines.filter((line) => !own.includes(line)).length : lines.length;
      if (n === 0) continue;
      for (const to of targets) {
        if (to === from) continue;
        add(m.fileOut[from], to, n);
        add(m.fileIn[to], from, n);
      }
    }
  });
}

/** The files that define `name`; none when so many do that it names no one symbol. */
export function definingFiles(m: Model, name: string): number[] {
  const ids = m.defsByName.get(name);
  if (!ids) return [];
  const files = [...new Set(ids.map((id) => m.defs[id]?.file ?? -1))];
  return files.length > MAX_NAMESAKE_FILES ? [] : files;
}

/** A use on the line that defines the name in the file using it is that definition, not a use. */
export function declares(m: Model, file: number, name: string, line: number): boolean {
  return (m.defsOfFile[file] ?? []).some((id) => {
    const d = m.defs[id];
    return d !== undefined && d.name === name && d.start === line;
  });
}

/** The innermost definition of `file` holding `line`, if any. */
export function within(m: Model, file: number, line: number): number | undefined {
  let best: number | undefined;
  for (const id of m.defsOfFile[file] ?? []) {
    const d = m.defs[id];
    if (!d || d.start > line) break;
    if (d.end < line) continue;
    const b = best === undefined ? undefined : m.defs[best];
    if (!b || d.end - d.start <= b.end - b.start) best = id;
  }
  return best;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list[list.length - 1] !== value) list.push(value);
}

function add(map: Map<number, number> | undefined, key: number, n: number) {
  map?.set(key, (map.get(key) ?? 0) + n);
}

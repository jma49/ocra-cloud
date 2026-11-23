// The changed files as a tree to read down: folders in the order their
// first file was listed, a chain of folders that hold nothing else joined
// into one row ("core/src/runtime"), each file under its folder.

export type TreeRow<F> =
  | { kind: "dir"; name: string; depth: number; path: string }
  | { kind: "file"; name: string; depth: number; file: F };

type Dir<F> = { dirs: Map<string, Dir<F>>; files: { name: string; file: F }[] };

const dir = <F>(): Dir<F> => ({ dirs: new Map(), files: [] });

function rows<F>(at: Dir<F>, depth: number, path: string): TreeRow<F>[] {
  const out: TreeRow<F>[] = [];
  for (const [first, child] of at.dirs) {
    let name = first;
    let inner = child;
    // A folder whose one entry is a folder reads as one row with it.
    while (inner.files.length === 0 && inner.dirs.size === 1) {
      const [next] = inner.dirs;
      if (!next) break;
      name = `${name}/${next[0]}`;
      inner = next[1];
    }
    const here = path ? `${path}/${name}` : name;
    out.push({ kind: "dir", name, depth, path: here }, ...rows(inner, depth + 1, here));
  }
  for (const f of at.files) out.push({ kind: "file", name: f.name, depth, file: f.file });
  return out;
}

export function fileTree<F extends { path: string }>(files: readonly F[]): TreeRow<F>[] {
  const root = dir<F>();
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let at = root;
    for (const part of parts) {
      let next = at.dirs.get(part);
      if (!next) {
        next = dir<F>();
        at.dirs.set(part, next);
      }
      at = next;
    }
    at.files.push({ name, file });
  }
  return rows(root, 0, "");
}

/** The files in the order the tree lists them, so the diffs read down in the same order. */
export function treeOrder<F extends { path: string }>(files: readonly F[]): F[] {
  return fileTree(files).flatMap((row) => (row.kind === "file" ? [row.file] : []));
}

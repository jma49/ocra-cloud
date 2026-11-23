import type { DiffLine } from "./diff.js";
import type { WordRange } from "./diff-words.js";

// Text found in a pull request's diffs: every line of every file, drawn or
// not, folded or not, since the browser's own find sees only what is drawn.

/** One place the text is: the file, the line's index in its parsed diff, the stretch. */
export type DiffMatch = { path: string; line: number; from: number; to: number };

/** Past this many the search stops counting: the reader narrows it instead. */
export const MAX_MATCHES = 5000;

/** Every place `query` is, ignoring case, file by file and line by line in order. */
export function findInDiffs(
  files: readonly { path: string; lines: readonly DiffLine[] }[],
  query: string,
): DiffMatch[] {
  const wanted = query.toLowerCase();
  if (!wanted) return [];
  const out: DiffMatch[] = [];
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      if (!line || line.kind === "hunk") continue;
      const text = line.text.toLowerCase();
      for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + wanted.length)) {
        out.push({ path: file.path, line: i, from: at, to: at + wanted.length });
        if (out.length >= MAX_MATCHES) return out;
      }
    }
  }
  return out;
}

/** The matches as ranges by line, file by file, the way a row marks them. */
export function rangesByFile(matches: readonly DiffMatch[]): Map<string, Map<number, WordRange[]>> {
  const out = new Map<string, Map<number, WordRange[]>>();
  for (const m of matches) {
    const file = out.get(m.path) ?? new Map<number, WordRange[]>();
    file.set(m.line, [...(file.get(m.line) ?? []), { from: m.from, to: m.to }]);
    out.set(m.path, file);
  }
  return out;
}

import type { DiffLine } from "./diff.js";

// A diff's rows as the page draws them, in either layout. Unified gives each
// line its own row; split sets a removed line beside the added line that took
// its place. A row names lines by their index in the parsed diff, so notes
// and comments keep anchoring to the same line in both.

export type DiffLayout = "unified" | "split";

export type DiffRow =
  | { kind: "hunk"; line: number }
  | { kind: "line"; line: number }
  | { kind: "pair"; left: number | null; right: number | null };

export function rowsOf(lines: readonly DiffLine[], layout: DiffLayout): DiffRow[] {
  if (layout === "unified")
    return lines.map((l, i) => ({ kind: l.kind === "hunk" ? "hunk" : "line", line: i }));
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = lines[i]?.kind;
    if (kind === "hunk") rows.push({ kind: "hunk", line: i++ });
    else if (kind === "context") {
      rows.push({ kind: "pair", left: i, right: i });
      i++;
    } else {
      const dels: number[] = [];
      while (lines[i]?.kind === "del") dels.push(i++);
      const adds: number[] = [];
      while (lines[i]?.kind === "add") adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        rows.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/** The lines a row shows, which notes anchored to any of them follow. */
export function linesOfRow(row: DiffRow): number[] {
  if (row.kind !== "pair") return [row.line];
  if (row.left === row.right) return row.left === null ? [] : [row.left];
  return [row.left, row.right].filter((n): n is number => n !== null);
}

/** Rows cut into runs of `size`, each drawn or left out as one. */
export function chunksOf<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}

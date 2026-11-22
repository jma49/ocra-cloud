import type { LineSide } from "../../../src/shared/index.js";

// A file's unified diff, as the platform sends it, taken apart into lines
// with their numbers on each side, so the page can draw it and anchor a
// comment to a line the platform accepts.

export type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "context"; old: number; new: number; text: string }
  | { kind: "add"; new: number; text: string }
  | { kind: "del"; old: number; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    // Before the first hunk, "\ No newline at end of file", and the empty string a
    // trailing newline leaves are not lines of the file.
    if (lines.length === 0 || raw === "" || raw.startsWith("\\")) continue;
    const text = raw.slice(1);
    if (raw.startsWith("+")) lines.push({ kind: "add", new: newNo++, text });
    else if (raw.startsWith("-")) lines.push({ kind: "del", old: oldNo++, text });
    else lines.push({ kind: "context", old: oldNo++, new: newNo++, text });
  }
  return lines;
}

/** Where a comment on this line lands: the new side unless the line was removed. */
export function anchorOf(line: DiffLine): { line: number; side: LineSide } | null {
  if (line.kind === "hunk") return null;
  if (line.kind === "del") return { line: line.old, side: "old" };
  return { line: line.new, side: "new" };
}

export type TreeEntry = { dir: string; name: string };

/** A path as the file list shows it: its folder dimmed, then its name. */
export function splitPath(path: string): TreeEntry {
  const at = path.lastIndexOf("/");
  return at < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/**
 * The diff's line, by index, that each item goes under: the new line its range
 * ends on. Items whose line the diff does not show are under -1, the diff's top.
 */
export function placeOnLines<T extends { endLine: number }>(
  lines: readonly DiffLine[],
  items: readonly T[],
): Map<number, T[]> {
  const at = new Map<number, number>();
  lines.forEach((line, i) => {
    if (line.kind === "add" || line.kind === "context") at.set(line.new, i);
  });
  const placed = new Map<number, T[]>();
  for (const item of items) {
    const i = at.get(item.endLine) ?? -1;
    placed.set(i, [...(placed.get(i) ?? []), item]);
  }
  return placed;
}

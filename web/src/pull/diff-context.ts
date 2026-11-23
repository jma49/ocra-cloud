import type { DiffLine } from "./diff.js";

// The unchanged lines the platform left out of a diff, between its hunks and
// after the last one, shown a few at a time as the reader asks. Lines read
// from the file at the head are kept by their new number; a gap shows the
// ones next to the hunk above it (top) and below it (bottom).

/** Lines of the file between two hunks, by new number; `to` null runs to the file's end, still unknown. */
export type Gap = { key: number; from: number; to: number | null; delta: number };

/** What the reader has opened: the lines read so far, the file's length once known, each gap's shown ends. */
export type Revealed = {
  known: ReadonlyMap<number, string>;
  total: number | null;
  shown: ReadonlyMap<number, { top: number; bottom: number }>;
};

export const NOTHING_REVEALED: Revealed = { known: new Map(), total: null, shown: new Map() };

/** A gap still partly hidden, as a row of the diff shows it. */
export type OpenGap = { gap: Gap; hidden: number | null };

/** The gaps of a parsed diff: before each hunk, and after the last one. Gap keys are hunk ordinals. */
export function gapsOf(lines: readonly DiffLine[]): Gap[] {
  const gaps: Gap[] = [];
  let nextNew = 1;
  let nextOld = 1;
  let hunk = 0;
  for (const line of lines) {
    if (line.kind === "hunk") {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line.text);
      const oldStart = Number(m?.[1] ?? 1);
      const newStart = Number(m?.[2] ?? 1);
      gaps.push({ key: hunk++, from: nextNew, to: newStart - 1, delta: oldStart - newStart });
      nextNew = newStart;
      nextOld = oldStart;
    } else {
      if (line.kind !== "del") nextNew++;
      if (line.kind !== "add") nextOld++;
    }
  }
  if (hunk > 0) gaps.push({ key: hunk, from: nextNew, to: null, delta: nextOld - nextNew });
  return gaps;
}

const hiddenIn = (gap: Gap, revealed: Revealed): number | null => {
  const to = gap.to ?? revealed.total;
  if (to === null) return null;
  const shown = revealed.shown.get(gap.key) ?? { top: 0, bottom: 0 };
  return Math.max(0, to - gap.from + 1 - shown.top - shown.bottom);
};

const context = (gap: Gap, n: number, revealed: Revealed): DiffLine => ({
  kind: "context",
  new: n,
  old: n + gap.delta,
  text: revealed.known.get(n) ?? "",
});

/**
 * The diff with the revealed lines in place: a gap's top lines after the hunk
 * above it, its bottom lines before the hunk below. The row before a gap's
 * bottom carries its controls while lines are still hidden there.
 */
export function withContext(
  lines: readonly DiffLine[],
  gaps: readonly Gap[],
  revealed: Revealed,
): { lines: DiffLine[]; open: Map<number, OpenGap> } {
  const out: DiffLine[] = [];
  const open = new Map<number, OpenGap>();
  const place = (gap: Gap | undefined, head: DiffLine | null) => {
    if (!gap) return;
    const shown = revealed.shown.get(gap.key) ?? { top: 0, bottom: 0 };
    const hidden = hiddenIn(gap, revealed);
    for (let n = gap.from; n < gap.from + shown.top; n++) out.push(context(gap, n, revealed));
    const hides = hidden !== 0;
    // A hunk's own head stays until the reader has opened all of the gap above it.
    if (hides || (head && shown.top + shown.bottom === 0)) {
      if (hides) open.set(out.length, { gap, hidden });
      out.push(head ?? { kind: "hunk", text: "" });
    }
    const end = gap.to ?? revealed.total ?? gap.from - 1;
    for (let n = end - shown.bottom + 1; n <= end; n++) out.push(context(gap, n, revealed));
  };
  let hunk = 0;
  for (const line of lines) {
    if (line.kind === "hunk") place(gaps[hunk++], line);
    else out.push(line);
  }
  place(gaps[hunk], null);
  return { lines: out, open };
}

/** Lines one click opens. */
export const STEP = 20;

/** Which new lines to read for a click, and the gap's shown ends after it; null when nothing is left. */
export function revealStep(
  gap: Gap,
  revealed: Revealed,
  direction: "up" | "down" | "all",
): { from: number; to: number; shown: { top: number; bottom: number } } | null {
  const shown = revealed.shown.get(gap.key) ?? { top: 0, bottom: 0 };
  const hidden = hiddenIn(gap, revealed);
  if (hidden === 0) return null;
  const first = gap.from + shown.top;
  if (hidden === null) {
    // The file's end is unknown: read down from the last hunk; the answer says where it ends.
    return { from: first, to: first + STEP - 1, shown: { ...shown, top: shown.top + STEP } };
  }
  const last = first + hidden - 1;
  if (direction === "all" || hidden <= STEP)
    return { from: first, to: last, shown: { top: shown.top + hidden, bottom: shown.bottom } };
  if (direction === "down")
    return { from: first, to: first + STEP - 1, shown: { ...shown, top: shown.top + STEP } };
  return { from: last - STEP + 1, to: last, shown: { ...shown, bottom: shown.bottom + STEP } };
}

/** The shown ends once the file's length is known: the top never runs past its last line. */
export function clampShown(
  gap: Gap,
  shown: { top: number; bottom: number },
  total: number,
): { top: number; bottom: number } {
  const size = Math.max(0, (gap.to ?? total) - gap.from + 1);
  const top = Math.min(shown.top, size);
  return { top, bottom: Math.min(shown.bottom, size - top) };
}

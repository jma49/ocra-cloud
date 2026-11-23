import type { DiffLine } from "./diff.js";

// Which words of a changed line changed: a removed line and the added line
// that took its place are compared word by word, so the eye goes to what
// differs rather than to the whole line.

/** A changed stretch of a line's text, by character offsets [from, to). */
export type WordRange = { from: number; to: number };

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Past these a pair is left whole: comparing it costs more than it shows. */
const MAX_LINE_CHARS = 500;
const MAX_CELLS = 20_000;
/** Below this share of text in common a line was rewritten, and marking all of it says nothing. */
const MIN_KEPT = 0.4;

const tokens = (text: string) => text.match(TOKEN) ?? [];

/** The changed ranges of each side, or null when the lines share too little to compare. */
export function changedWords(
  before: string,
  after: string,
): { before: WordRange[]; after: WordRange[] } | null {
  if (before === after || before.length > MAX_LINE_CHARS || after.length > MAX_LINE_CHARS)
    return null;
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) return null;
  // Longest common subsequence of tokens, from the ends, so the walk below goes forward.
  const width = b.length + 1;
  const common = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  let kept = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i] = true;
      keptB[j] = true;
      kept += a[i]?.length ?? 0;
      i++;
      j++;
    } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  if (kept < MIN_KEPT * Math.max(before.length, after.length)) return null;
  return { before: rangesOf(a, keptA), after: rangesOf(b, keptB) };
}

/** The stretches of tokens not kept, joined across the blank between two of them. */
function rangesOf(parts: string[], kept: boolean[]): WordRange[] {
  const out: WordRange[] = [];
  let at = 0;
  parts.forEach((part, k) => {
    const from = at;
    at += part.length;
    if (kept[k]) {
      const blankBetween = /^\s+$/.test(part) && kept[k + 1] === false && kept[k - 1] === false;
      if (!blankBetween) return;
    }
    const last = out[out.length - 1];
    if (last && last.to === from) last.to = at;
    else out.push({ from, to: at });
  });
  return out;
}

/**
 * Each changed line's ranges, by the line's index: within a hunk, a run of
 * removed lines and the run of added lines after it are paired in order.
 */
export function wordChanges(lines: readonly DiffLine[]): Map<number, WordRange[]> {
  const out = new Map<number, WordRange[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== "del") {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (lines[i]?.kind === "del") dels.push(i++);
    const adds: number[] = [];
    while (lines[i]?.kind === "add") adds.push(i++);
    dels.forEach((d, k) => {
      const a = adds[k];
      const before = lines[d];
      const after = a === undefined ? undefined : lines[a];
      if (a === undefined || !before || !after) return;
      const ranges = changedWords(before.text, after.text);
      if (!ranges) return;
      out.set(d, ranges.before);
      out.set(a, ranges.after);
    });
  }
  return out;
}

/** A run of a line's text: its token kind (null for plain), whether it changed, whether a search found it. */
export type MarkedRun = { text: string; kind: string | null; changed: boolean; found: boolean };

const within = (ranges: readonly WordRange[] | undefined, at: number) =>
  ranges?.some((r) => at >= r.from && at < r.to) ?? false;

/** The line's runs cut where a changed or found range starts or ends. */
export function markRuns(
  runs: readonly { text: string; kind: string | null }[],
  changed: readonly WordRange[] | undefined,
  found?: readonly WordRange[] | undefined,
): MarkedRun[] {
  if (!changed?.length && !found?.length)
    return runs.map((r) => ({ ...r, changed: false, found: false }));
  const cuts = new Set<number>();
  for (const r of [...(changed ?? []), ...(found ?? [])]) {
    cuts.add(r.from);
    cuts.add(r.to);
  }
  const out: MarkedRun[] = [];
  let at = 0;
  for (const run of runs) {
    let from = 0;
    for (let k = 1; k <= run.text.length; k++) {
      if (k < run.text.length && !cuts.has(at + k)) continue;
      const text = run.text.slice(from, k);
      const marks = { changed: within(changed, at + from), found: within(found, at + from) };
      const last = out[out.length - 1];
      if (
        last &&
        last.kind === run.kind &&
        last.changed === marks.changed &&
        last.found === marks.found
      )
        last.text += text;
      else out.push({ text, kind: run.kind, ...marks });
      from = k;
    }
    at += run.text.length;
  }
  return out;
}

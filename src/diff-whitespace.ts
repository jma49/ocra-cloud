// A file's unified diff with changes of whitespace alone taken out, as
// `git diff -w` would show it: a removed line and an added one that differ
// only in whitespace (indentation, trailing spaces, CRLF) become one
// unchanged line, shown as the new side has it. Every line keeps its number
// on each side, so comments, findings and the lines read around a hunk still
// land where they did; a hunk is cut down to the lines around what is still
// changed, and one with nothing left is left out.

/** Unchanged lines kept around a change, as the platforms send them. */
const CONTEXT = 3;
/** Past this many removed × added lines in one change, only its ends are matched. */
const MAX_PAIRS = 1_000_000;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The number of a side's first line: a side with none names the line before it. */
const firstOf = (start: string | undefined, count: string | undefined) =>
  Number(start) + (count === "0" ? 1 : 0);

/** A line of a hunk; its numbers are counted once its lines stand in their final order. */
type Line = { kind: " " | "-" | "+"; text: string; old: number; new: number; tail: string[] };

const key = (text: string) => text.replace(/\s+/g, "");

/** The diff without whitespace-only changes: "" when nothing else changed. */
export function ignoreWhitespace(patch: string): string {
  const out: string[] = [];
  for (const hunk of hunksOf(patch))
    out.push(...cut(numbered(matched(hunk.lines), hunk.old, hunk.new), hunk.heading));
  return out.join("\n");
}

/** The lines a diff adds and removes, as a file's +/− counts show them. */
export function changeCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (HUNK.test(raw)) inHunk = true;
    else if (inHunk && raw.startsWith("+")) additions++;
    else if (inHunk && raw.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

type Hunk = { heading: string; old: number; new: number; lines: Line[] };

function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const raw of patch.split("\n")) {
    const head = HUNK.exec(raw);
    if (head) {
      hunks.push({
        heading: head[5] ?? "",
        old: firstOf(head[1], head[2]),
        new: firstOf(head[3], head[4]),
        lines: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk || raw === "") continue;
    // "\ No newline at end of file" goes with the line before it.
    if (raw.startsWith("\\")) {
      hunk.lines.at(-1)?.tail.push(raw);
      continue;
    }
    const kind = raw[0] === "-" ? "-" : raw[0] === "+" ? "+" : " ";
    hunk.lines.push({ kind, text: raw.slice(1), old: 0, new: 0, tail: [] });
  }
  return hunks;
}

/** The hunk with each removed line that an added one only re-spaces made unchanged. */
function matched(lines: Line[]): Line[] {
  const out: Line[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] as Line;
    if (line.kind === " ") {
      out.push(line);
      at++;
      continue;
    }
    const dels: Line[] = [];
    const adds: Line[] = [];
    while (at < lines.length && lines[at]?.kind !== " ") {
      const l = lines[at++] as Line;
      (l.kind === "-" ? dels : adds).push(l);
    }
    out.push(...aligned(dels, adds));
  }
  return out;
}

/** One change's lines in order, its removed and added lines matched by what they say without whitespace. */
function aligned(dels: Line[], adds: Line[]): Line[] {
  const pairs = pairsOf(
    dels.map((l) => key(l.text)),
    adds.map((l) => key(l.text)),
  );
  const out: Line[] = [];
  let d = 0;
  let a = 0;
  for (const [i, j] of [...pairs, [dels.length, adds.length] as const]) {
    while (d < i) out.push(dels[d++] as Line);
    while (a < j) out.push(adds[a++] as Line);
    if (i === dels.length && j === adds.length) break;
    d++;
    out.push({ ...(adds[a++] as Line), kind: " ", tail: [] });
  }
  return out;
}

/** The longest run of matching lines common to both, as index pairs in order. */
function pairsOf(old: string[], now: string[]): [number, number][] {
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < now.length - start &&
    old[old.length - 1 - end] === now[now.length - 1 - end]
  )
    end++;
  const head = Array.from({ length: start }, (_, i): [number, number] => [i, i]);
  const tail = Array.from({ length: end }, (_, k): [number, number] => [
    old.length - end + k,
    now.length - end + k,
  ]);
  const n = old.length - start - end;
  const m = now.length - start - end;
  if (n === 0 || m === 0 || n * m > MAX_PAIRS) return [...head, ...tail];
  // Lengths of the longest common runs of the middles' suffixes, then a walk from the front.
  const w = m + 1;
  const best = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      best[i * w + j] =
        old[start + i] === now[start + j]
          ? (best[(i + 1) * w + j + 1] as number) + 1
          : Math.max(best[(i + 1) * w + j] as number, best[i * w + j + 1] as number);
  const middle: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (old[start + i] === now[start + j]) middle.push([start + i++, start + j++]);
    else if ((best[(i + 1) * w + j] as number) >= (best[i * w + j + 1] as number)) i++;
    else j++;
  }
  return [...head, ...middle, ...tail];
}

/** Each line's number on each side, counted again in the order the lines now stand. */
function numbered(lines: Line[], oldNo: number, newNo: number): Line[] {
  return lines.map((l) => {
    const at = { ...l, old: oldNo, new: newNo };
    if (l.kind !== "+") oldNo++;
    if (l.kind !== "-") newNo++;
    return at;
  });
}

/** The hunk cut into the hunks around what still changes, each with its header. */
function cut(lines: Line[], heading: string): string[] {
  const changed = lines.flatMap((l, i) => (l.kind === " " ? [] : [i]));
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k] as number;
    let last = first;
    // Changes closer than twice the context share a hunk, as git joins them.
    while (k + 1 < changed.length && (changed[k + 1] as number) - last <= 2 * CONTEXT + 1)
      last = changed[++k] as number;
    k++;
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(lines.length - 1, last + CONTEXT);
    const part = lines.slice(from, to + 1);
    const top = part[0] as Line;
    const olds = part.filter((l) => l.kind !== "+").length;
    const news = part.filter((l) => l.kind !== "-").length;
    // A side with no lines names the line before where it would be, as git writes it.
    const oldStart = olds === 0 ? top.old - 1 : top.old;
    const newStart = news === 0 ? top.new - 1 : top.new;
    out.push(`@@ -${oldStart},${olds} +${newStart},${news} @@${out.length === 0 ? heading : ""}`);
    for (const l of part) out.push(`${l.kind}${l.text}`, ...(l.kind === " " ? [] : l.tail));
  }
  return out;
}

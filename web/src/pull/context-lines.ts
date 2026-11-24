import { useEffect, useMemo, useState } from "react";
import type { PullLinesView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useToast } from "../toast.js";
import type { DiffLine } from "./diff.js";
import {
  clampShown,
  type Gap,
  gapsOf,
  NOTHING_REVEALED,
  type OpenGap,
  type Revealed,
  revealStep,
  STEP,
  withContext,
} from "./diff-context.js";

type Pull = { platform: string; repo: string; number: number };

/** Where a file's unchanged lines are read: the pull request and the head its diff is of. */
export type ContextSource = { pull: Pull; head: string };

export type Expand = (gap: Gap, direction: "up" | "down" | "all") => void;

/**
 * A file's diff with the unchanged lines the reader opened, and a way to open
 * more: each click reads the lines it shows, as the user, at the head shown.
 * A file the console cannot read as text keeps its gaps closed. Once `active`,
 * the lines after the last hunk are read ahead, so the row that opens them is
 * offered only when there are some, and its first click needs no request.
 */
export function useContextLines(
  parsed: readonly DiffLine[],
  path: string,
  source: ContextSource | undefined,
  active = true,
) {
  const offered = source !== undefined;
  const gaps = useMemo(() => (offered ? gapsOf(parsed) : []), [parsed, offered]);
  const [revealed, setRevealed] = useState<Revealed>(NOTHING_REVEALED);
  const [busy, setBusy] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);
  // The read-ahead of the file's end: not yet, under way, or done (failed included, which offers the row as before).
  const [ahead, setAhead] = useState<"no" | "reading" | "done">("no");
  const toast = useToast();
  const shown = useMemo(
    () =>
      offered && !closed
        ? withContext(parsed, gaps, revealed, ahead === "done")
        : { lines: [...parsed], open: new Map<number, OpenGap>() },
    [parsed, gaps, revealed, offered, closed, ahead],
  );
  const read = (from: number, to: number) =>
    api<PullLinesView>(
      `/pulls/lines?${new URLSearchParams({
        platform: source?.pull.platform ?? "",
        repo: source?.pull.repo ?? "",
        number: String(source?.pull.number ?? ""),
        head: source?.head ?? "",
        path,
        from: String(from),
        to: String(to),
      })}`,
    );
  /** Keeps what a read answered; `step` also moves a gap's shown ends. */
  const keep = (
    answer: PullLinesView,
    step?: { gap: Gap; shown: { top: number; bottom: number } },
  ) => {
    if (answer.lines === null) {
      setClosed(true);
      return;
    }
    setRevealed((r) => {
      const known = new Map(r.known);
      answer.lines?.forEach((text, i) => {
        known.set(answer.from + i, text);
      });
      const total = answer.total ?? r.total;
      const ends = new Map(r.shown);
      if (step) ends.set(step.gap.key, step.shown);
      if (total !== null)
        for (const g of gaps) {
          const s = ends.get(g.key);
          if (s && g.to === null) ends.set(g.key, clampShown(g, s, total));
        }
      return { known, total, shown: ends };
    });
  };
  const end = gaps.find((g) => g.to === null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per file, when it first comes near; `read` is remade each render.
  useEffect(() => {
    if (!active || !source || !end || ahead !== "no" || closed) return;
    setAhead("reading");
    read(end.from, end.from + STEP - 1)
      .then((answer) => keep(answer))
      .catch(() => undefined)
      .finally(() => setAhead("done"));
  }, [active, source, end, ahead, closed]);
  const expand: Expand = (gap, direction) => {
    const step = revealStep(gap, revealed, direction);
    if (!source || !step || busy !== null) return;
    const lines: string[] = [];
    for (let n = step.from; n <= step.to; n++) {
      const text = revealed.known.get(n);
      if (text === undefined) break;
      lines.push(text);
    }
    // Lines already read ahead open at once, up to where the file ends.
    const last = revealed.total === null ? null : Math.min(step.to, revealed.total);
    if (last !== null && lines.length >= last - step.from + 1) {
      keep(
        { path, head: source.head, from: step.from, lines, total: revealed.total },
        { gap, shown: step.shown },
      );
      return;
    }
    setBusy(gap.key);
    read(step.from, step.to)
      .then((answer) => keep(answer, { gap, shown: step.shown }))
      .catch(() => toast("Could not read the file's other lines. Try again.", "error"))
      .finally(() => setBusy(null));
  };
  return { lines: shown.lines, open: shown.open, expand, busy };
}

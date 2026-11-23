import { useMemo, useState } from "react";
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
  withContext,
} from "./diff-context.js";

type Pull = { platform: string; repo: string; number: number };

/** Where a file's unchanged lines are read: the pull request and the head its diff is of. */
export type ContextSource = { pull: Pull; head: string };

export type Expand = (gap: Gap, direction: "up" | "down" | "all") => void;

/**
 * A file's diff with the unchanged lines the reader opened, and a way to open
 * more: each click reads the lines it shows, as the user, at the head shown.
 * A file the console cannot read as text keeps its gaps closed.
 */
export function useContextLines(
  parsed: readonly DiffLine[],
  path: string,
  source: ContextSource | undefined,
) {
  const offered = source !== undefined;
  const gaps = useMemo(() => (offered ? gapsOf(parsed) : []), [parsed, offered]);
  const [revealed, setRevealed] = useState<Revealed>(NOTHING_REVEALED);
  const [busy, setBusy] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);
  const toast = useToast();
  const shown = useMemo(
    () =>
      offered && !closed
        ? withContext(parsed, gaps, revealed)
        : { lines: [...parsed], open: new Map<number, OpenGap>() },
    [parsed, gaps, revealed, offered, closed],
  );
  const expand: Expand = (gap, direction) => {
    const step = revealStep(gap, revealed, direction);
    if (!source || !step || busy !== null) return;
    setBusy(gap.key);
    const query = new URLSearchParams({
      platform: source.pull.platform,
      repo: source.pull.repo,
      number: String(source.pull.number),
      head: source.head,
      path,
      from: String(step.from),
      to: String(step.to),
    });
    api<PullLinesView>(`/pulls/lines?${query}`)
      .then((read) => {
        if (read.lines === null) {
          setClosed(true);
          return;
        }
        setRevealed((r) => {
          const known = new Map(r.known);
          read.lines?.forEach((text, i) => {
            known.set(read.from + i, text);
          });
          const total = read.total ?? r.total;
          const ends = new Map(r.shown).set(gap.key, step.shown);
          if (total !== null)
            for (const g of gaps) {
              const s = ends.get(g.key);
              if (s && g.to === null) ends.set(g.key, clampShown(g, s, total));
            }
          return { known, total, shown: ends };
        });
      })
      .catch(() => toast("Could not read the file's other lines. Try again.", "error"))
      .finally(() => setBusy(null));
  };
  return { lines: shown.lines, open: shown.open, expand, busy };
}

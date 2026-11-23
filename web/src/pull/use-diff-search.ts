import { useEffect, useMemo, useRef, useState } from "react";
import type { PullFilesView } from "../../../src/shared/index.js";
import { parsePatch } from "./diff.js";
import { findInDiffs, rangesByFile } from "./diff-search.js";
import type { WordRange } from "./diff-words.js";

type File = PullFilesView["files"][number];

/** The match being shown: its file, line and start, and a count that moves on each step. */
export type SearchFocus = { path: string; line: number; from: number; to: number; step: number };

const isFind = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";

/**
 * Find in the pull request's diffs. ⌘F or Ctrl+F opens it over the browser's
 * own find, which sees only the lines drawn; the same keys again, from its
 * field, give the browser's find back.
 */
export function useDiffSearch(files: readonly File[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [step, setStep] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const parsed = useMemo(
    () =>
      open ? files.map((f) => ({ path: f.path, lines: f.patch ? parsePatch(f.patch) : [] })) : [],
    [files, open],
  );
  const matches = useMemo(() => findInDiffs(parsed, query), [parsed, query]);
  const found = useMemo(() => rangesByFile(matches), [matches]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFind(e) || document.activeElement === field.current) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => field.current?.select());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const current = matches.length ? matches[Math.min(at, matches.length - 1)] : undefined;
  const move = (by: 1 | -1) => {
    if (!matches.length) return;
    setAt((a) => (Math.min(a, matches.length - 1) + by + matches.length) % matches.length);
    setStep((n) => n + 1);
  };
  return {
    open,
    field,
    query,
    count: matches.length,
    at: current ? Math.min(at, matches.length - 1) : -1,
    found: open ? found : NOTHING_FOUND,
    focus: open && current ? ({ ...current, step } satisfies SearchFocus) : null,
    search: (q: string) => {
      setQuery(q);
      setAt(0);
      setStep((n) => n + 1);
    },
    next: () => move(1),
    previous: () => move(-1),
    close: () => setOpen(false),
  };
}

const NOTHING_FOUND: ReadonlyMap<string, Map<number, WordRange[]>> = new Map();

import { type RefObject, useEffect, useState } from "react";

/**
 * The row a list's keys act on: `j`/`k` move it, and it stays in view. Rows
 * carry `data-row` with their index under `list`. Unless `always`, it shows
 * only once a key has moved it, and the first press shows it where it is.
 */
export function useListCursor(count: number, list: RefObject<HTMLElement | null>, always = false) {
  const [at, setAt] = useState(0);
  const [keyed, setKeyed] = useState(always);
  const last = Math.max(count - 1, 0);
  const current = Math.min(at, last);
  useEffect(() => {
    if (!keyed) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, keyed, list]);
  return {
    current,
    /** Whether the row is marked as the keys' own. */
    shown: keyed && count > 0,
    move: (step: 1 | -1) => {
      if (keyed) setAt((a) => Math.max(0, Math.min(last, Math.min(a, last) + step)));
      setKeyed(true);
    },
    /** Marks the current row as the keys', as acting on it by key does. */
    show: () => setKeyed(true),
    reset: () => {
      setAt(0);
      setKeyed(always);
    },
  };
}

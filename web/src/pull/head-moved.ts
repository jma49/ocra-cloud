import { useCallback, useEffect, useState } from "react";
import { usePoll } from "../ui.js";

/** How often the page reads the pull request again while it waits for a commit to show. */
const HEAD_POLL_MS = 2_000;
/** How long it waits before it takes the head it reads as the one the platform has. */
const HEAD_WAIT_MS = 30_000;

/**
 * After a commit ocra or the person made from this page: the platform moves
 * the pull request's head a moment after the commit, so a read right away
 * can still answer the old one. This reads again until the head moves.
 */
export function useHeadMoved(head: string | undefined, reload: () => void) {
  const [from, setFrom] = useState<string | null>(null);
  const waiting = from !== null && from === head;
  usePoll(waiting, reload, HEAD_POLL_MS);
  useEffect(() => {
    if (!waiting) return;
    const stop = setTimeout(() => setFrom(null), HEAD_WAIT_MS);
    return () => clearTimeout(stop);
  }, [waiting]);
  return useCallback(() => {
    setFrom(head ?? null);
    reload();
  }, [head, reload]);
}

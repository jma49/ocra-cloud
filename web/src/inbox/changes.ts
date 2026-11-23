import { useCallback } from "react";
import type { PullsChange } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { usePoll } from "../ui.js";

/** How often the open inbox asks whether its pull requests changed: a read of ours, no platform call. */
const WATCH_MS = 30_000;

/** Whether the server's change time is past the one the listing carried. */
const changedSince = (now: string | null | undefined, listed: string | null | undefined) =>
  typeof now === "string" && (typeof listed !== "string" || Date.parse(now) > Date.parse(listed));

/**
 * Reads the listing again when a webhook or a review said one of the
 * account's pull requests changed after it was read (`listed`, its change
 * time; undefined while none is read yet); asks nothing of the platforms
 * otherwise.
 */
export function usePullsChanged(listed: string | null | undefined, reload: () => void) {
  const check = useCallback(() => {
    api<PullsChange>("/platforms/pulls/changed").then(
      (now) => {
        if (changedSince(now?.changedAt, listed)) reload();
      },
      () => {},
    );
  }, [listed, reload]);
  usePoll(listed !== undefined, check, WATCH_MS);
}

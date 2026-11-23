import { useCallback, useEffect, useRef, useState } from "react";
import type { PullsChange } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { usePoll } from "../ui.js";

/** How often the open inbox asks whether its pull requests changed while it has no stream: a read of ours, no platform call. */
const WATCH_MS = 30_000;
/** A burst of webhooks (a push's checks) is read as one change. */
const SETTLE_MS = 1_000;
const STREAM = "/api/platforms/pulls/changed/stream";

/** Whether the server's change time is past the one the listing carried. */
const changedSince = (now: string | null | undefined, listed: string | null | undefined) =>
  typeof now === "string" && (typeof listed !== "string" || Date.parse(now) > Date.parse(listed));

/**
 * Reads the listing again when a webhook or a review said one of the
 * account's pull requests changed after it was read (`listed`, its change
 * time; undefined while none is read yet); asks nothing of the platforms
 * otherwise. The server pushes changes while the tab is in view; without
 * the stream (refused, or reconnecting) the inbox asks every WATCH_MS.
 */
export function usePullsChanged(listed: string | null | undefined, reload: () => void) {
  const check = useCallback(() => {
    if (listed === undefined) return;
    api<PullsChange>("/platforms/pulls/changed").then(
      (now) => {
        if (changedSince(now?.changedAt, listed)) reload();
      },
      () => {},
    );
  }, [listed, reload]);
  const latest = useRef(check);
  useEffect(() => {
    latest.current = check;
  }, [check]);
  const live = usePullsStream(latest);
  usePoll(listed !== undefined && !live, check, WATCH_MS);
}

/** Whether the stream is open; `heard` runs on each change, and on each (re)open for what came between. */
function usePullsStream(heard: { current: () => void }): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (source) return;
      source = new EventSource(STREAM);
      source.addEventListener("ready", () => {
        setLive(true);
        heard.current();
      });
      source.addEventListener("pulls", () => {
        clearTimeout(settle);
        settle = setTimeout(() => heard.current(), SETTLE_MS);
      });
      // A stream ended or lost reconnects by itself; a refused one stays
      // closed. Either way the poll covers until the next `ready`.
      source.addEventListener("error", () => setLive(false));
    };
    const shut = () => {
      source?.close();
      source = null;
      clearTimeout(settle);
      setLive(false);
    };
    const shown = () => (document.visibilityState === "visible" ? open() : shut());
    shown();
    document.addEventListener("visibilitychange", shown);
    return () => {
      document.removeEventListener("visibilitychange", shown);
      shut();
    };
  }, [heard]);
  return live;
}

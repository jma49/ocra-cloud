import { useCallback, useEffect, useState } from "react";
import type {
  LiveCommentView,
  LiveEventView,
  LiveRunView,
  LiveShareView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useLoad } from "../ui.js";
import { emptyProgress, fold, type LiveProgress } from "./fold.js";

// A live run on the page: its row, its events from the stream (the browser
// reconnects with the last seq it has), and its comments, read again while
// the run is open.

export type LiveRunAnswer = { run: LiveRunView; share?: LiveShareView };

const COMMENTS_MS = 5_000;
const IDLE_COMMENTS_MS = 30_000;

/** The link's key when the page was opened from a share link. */
export const linkKey = () => new URLSearchParams(location.search).get("k") ?? "";

function liveQuery(key: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ ...(key ? { k: key } : {}), ...extra }).toString();
  return q ? `?${q}` : "";
}

export function useLive(id: string, key: string) {
  const run = useLoad(() => api<LiveRunAnswer>(`/live/${id}${liveQuery(key)}`), [id, key]);
  const [progress, setProgress] = useState<LiveProgress>(emptyProgress);
  const [connected, setConnected] = useState(false);
  const reloadRun = run.reload;

  useEffect(() => {
    setProgress(emptyProgress());
    const source = new EventSource(`/api/live/${id}/stream${liveQuery(key)}`);
    let pending: LiveEventView[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setProgress((p) => fold(p, batch));
    };
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("review", (e) => {
      pending.push(JSON.parse((e as MessageEvent<string>).data) as LiveEventView);
      frame ||= requestAnimationFrame(flush);
    });
    source.addEventListener("end", () => {
      source.close();
      setConnected(false);
      reloadRun();
    });
    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [id, key, reloadRun]);

  const running = run.data?.run.state === "running";
  const comments = useComments(id, key, running);
  return { run, progress, connected, comments };
}

function useComments(id: string, key: string, running: boolean) {
  const list = useLoad(
    () => api<{ comments: LiveCommentView[] }>(`/live/${id}/comments${liveQuery(key)}`),
    [id, key],
  );
  const reload = list.reload;
  useEffect(() => {
    const every = running ? COMMENTS_MS : IDLE_COMMENTS_MS;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, every);
    return () => clearInterval(timer);
  }, [running, reload]);

  const [added, setAdded] = useState<LiveCommentView[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const loaded = list.data?.comments;
  // A fresh list has what this page added.
  useEffect(() => {
    if (loaded) setAdded([]);
  }, [loaded]);
  const all = [
    ...(loaded ?? []),
    ...added.filter((a) => !loaded?.some((c) => c.id === a.id)),
  ].filter((c) => !removed.has(c.id));

  const add = useCallback(
    async (body: string, findingId: string | null) => {
      const c = await api<LiveCommentView>(`/live/${id}/comments${liveQuery(key)}`, {
        method: "POST",
        body: JSON.stringify({ body, findingId }),
      });
      setAdded((a) => [...a, c]);
      return c;
    },
    [id, key],
  );
  const remove = useCallback(
    async (commentId: string) => {
      setRemoved((r) => new Set(r).add(commentId));
      try {
        await api(`/live/${id}/comments/${commentId}${liveQuery(key)}`, { method: "DELETE" });
      } catch (e) {
        setRemoved((r) => {
          const next = new Set(r);
          next.delete(commentId);
          return next;
        });
        throw e;
      }
    },
    [id, key],
  );
  return { list, all, add, remove };
}

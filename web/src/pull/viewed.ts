import { useState } from "react";
import type { PullActionOutcome, PullFilesView } from "../../../src/shared/index.js";
import { api } from "../api.js";

type Pull = { platform: string; repo: string; number: number };

/**
 * Which files are ticked viewed: what the page read, with the ticks sent
 * from it over that; a new head reads them afresh. A tick shows at once and
 * goes back if the platform refuses it.
 */
export function useViewed(
  pull: Pull,
  data: PullFilesView | undefined,
  refused: (outcome: PullActionOutcome) => void,
) {
  const [ticked, setTicked] = useState<{ head: string; paths: ReadonlyMap<string, boolean> }>({
    head: "",
    paths: new Map(),
  });
  const sent = data && ticked.head === data.head ? ticked.paths : new Map<string, boolean>();
  const read = new Map(data?.files.map((f) => [f.path, f.viewed === true]));
  const isViewed = (path: string) => sent.get(path) ?? read.get(path) === true;
  const mark = async (path: string, viewed: boolean) => {
    if (!data) return;
    const { head } = data;
    // A path is a map key, never an object's: it may be any name, `__proto__` included.
    const withTick = (keep: boolean) =>
      setTicked((t) => {
        const paths = new Map(t.head === head ? t.paths : []);
        if (keep) paths.set(path, viewed);
        else paths.delete(path);
        return { head, paths };
      });
    withTick(true);
    const r = await api<{ outcome: PullActionOutcome }>("/pulls/viewed", {
      method: "POST",
      body: JSON.stringify({ ...pull, head, paths: [path], viewed }),
    }).catch(() => undefined);
    if (r?.outcome === "done") return;
    withTick(false);
    if (r) refused(r.outcome);
  };
  return { isViewed, mark, toggle: (path: string) => void mark(path, !isViewed(path)) };
}

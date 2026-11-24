import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type {
  FixJobView,
  MendItemView,
  PullFixJobsView,
  PullMendView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useLoad, usePoll } from "../ui.js";

// The fixes asked of ocra for a pull request's findings, and its fix loop
// where the repository lets ocra commit: read once for the page, and again
// every few seconds while one is queued or running.

const ACTIVE_MS = 5_000;

type FixJobs = {
  /** Whether the repository is one ocra reviews for this account: only there can a fix be asked for. */
  enrolled: boolean;
  of: (finding: string) => FixJobView | undefined;
  /** Whether ocra commits its fixes to this pull request's branch, in its fix loop. */
  commits: boolean;
  /** Whether a round of the loop is under way. */
  mending: boolean;
  /** What the loop was asked of the finding, and what became of it. */
  mendOf: (finding: string) => MendItemView | undefined;
  reload: () => void;
};

const NONE: FixJobs = {
  enrolled: false,
  of: () => undefined,
  commits: false,
  mending: false,
  mendOf: () => undefined,
  reload: () => undefined,
};
const Jobs = createContext<FixJobs>(NONE);

export const useFixJobs = () => useContext(Jobs);

const waiting = (j: FixJobView) => j.state === "queued" || j.state === "running";
const proposed = (j: FixJobView) => j.state === "done" && j.outcome === "proposed";
const turning = (loop: PullMendView["loop"] | undefined, items: MendItemView[] | undefined) =>
  loop?.state === "queued" || loop?.state === "running" || items?.some((i) => !i.outcome) === true;

/**
 * Holds the pull request's fix requests for the findings drawn inside it.
 * `onProposed` runs when a request the page watched comes back with a fix,
 * or the loop commits one, for the page to read the fix and its finding again.
 */
export function FixJobsOf(props: { query: string; onProposed: () => void; children: ReactNode }) {
  const { query } = props;
  const { data, reload } = useLoad(
    () => api<PullFixJobsView>(`/auto-review/fixes?${query}`),
    [query],
  );
  const jobs = data?.jobs;
  usePoll(jobs?.some(waiting) === true, reload, ACTIVE_MS);
  const loop = useLoad(() => api<PullMendView>(`/auto-review/mends?${query}`), [query]);
  const mend = loop.data;
  const items = mend?.items;
  const readLoop = loop.reload;
  usePoll(turning(mend?.loop, items), readLoop, ACTIVE_MS);

  const { onProposed } = props;
  const told = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!jobs) return;
    const now = new Set([
      ...jobs.filter(proposed).map((j) => j.id),
      ...(items ?? []).filter((i) => i.outcome === "fixed").map((i) => `mend:${i.finding}`),
    ]);
    // The first read's fixes are already on the page.
    const fresh = told.current !== null && [...now].some((id) => !told.current?.has(id));
    told.current = now;
    if (fresh) onProposed();
  }, [jobs, items, onProposed]);

  const value = useMemo<FixJobs>(() => {
    const byFinding = new Map(jobs?.map((j) => [j.finding, j]));
    const asked = new Map(items?.map((i) => [i.finding, i]));
    return {
      enrolled: data?.enrolled === true,
      of: (f) => byFinding.get(f),
      commits: mend?.level === "commit",
      mending: mend?.loop?.state === "running",
      mendOf: (f) => asked.get(f),
      reload: () => {
        reload();
        readLoop();
      },
    };
  }, [data?.enrolled, jobs, mend?.level, mend?.loop?.state, items, reload, readLoop]);
  return <Jobs.Provider value={value}>{props.children}</Jobs.Provider>;
}

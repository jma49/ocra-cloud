import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type { FixJobView, PullFixJobsView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useLoad, usePoll } from "../ui.js";

// The fixes asked of ocra for a pull request's findings: read once for the
// page, and again every few seconds while one is queued or running.

const ACTIVE_MS = 5_000;

type FixJobs = {
  /** Whether the repository is one ocra reviews for this account: only there can a fix be asked for. */
  enrolled: boolean;
  of: (finding: string) => FixJobView | undefined;
  reload: () => void;
};

const NONE: FixJobs = { enrolled: false, of: () => undefined, reload: () => undefined };
const Jobs = createContext<FixJobs>(NONE);

export const useFixJobs = () => useContext(Jobs);

const waiting = (j: FixJobView) => j.state === "queued" || j.state === "running";
const proposed = (j: FixJobView) => j.state === "done" && j.outcome === "proposed";

/**
 * Holds the pull request's fix requests for the findings drawn inside it.
 * `onProposed` runs when a request the page watched comes back with a fix,
 * for the page to read the fix and its finding again.
 */
export function FixJobsOf(props: { query: string; onProposed: () => void; children: ReactNode }) {
  const { query } = props;
  const { data, reload } = useLoad(
    () => api<PullFixJobsView>(`/auto-review/fixes?${query}`),
    [query],
  );
  const jobs = data?.jobs;
  usePoll(jobs?.some(waiting) === true, reload, ACTIVE_MS);

  const { onProposed } = props;
  const told = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!jobs) return;
    const now = new Set(jobs.filter(proposed).map((j) => j.id));
    // The first read's fixes are already on the page.
    const fresh = told.current !== null && [...now].some((id) => !told.current?.has(id));
    told.current = now;
    if (fresh) onProposed();
  }, [jobs, onProposed]);

  const value = useMemo<FixJobs>(() => {
    const byFinding = new Map(jobs?.map((j) => [j.finding, j]));
    return { enrolled: data?.enrolled === true, of: (f) => byFinding.get(f), reload };
  }, [data?.enrolled, jobs, reload]);
  return <Jobs.Provider value={value}>{props.children}</Jobs.Provider>;
}

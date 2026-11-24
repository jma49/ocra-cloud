import type { CiLogSource, CiRerunOutcome, PullCiJob } from "../shared/index.js";

// A pull request's CI on its head, read and run again as the user.

type CiListing = {
  head: string;
  pipeline: { id: string; url: string | null } | null;
  jobs: PullCiJob[];
  more: boolean;
};

/** A job's log, still uncut: `shownLog` makes what the console shows of it. */
type CiLog = { name: string; url: string | null; source: CiLogSource; text: string };

export interface PullCi {
  /** null when the token does not reach the pull request, or the platform failed. */
  jobs(token: string, fullName: string, number: number): Promise<CiListing | null>;
  /** null when the platform has no such job on the repository, or failed. */
  log(token: string, fullName: string, job: string): Promise<CiLog | null>;
  /**
   * Runs again the failed jobs of `head`, or the one `job` names; null when
   * the platform failed.
   */
  rerun(
    token: string,
    fullName: string,
    number: number,
    head: string,
    job: string | null,
  ): Promise<{ outcome: CiRerunOutcome; rerun: number } | null>;
}

const ORDER = { failed: 0, pending: 1, neutral: 2, cancelled: 3, skipped: 4, passed: 5 } as const;

/** Failed first, then pending, then the rest, each by name. */
export const sortJobs = (jobs: PullCiJob[]) =>
  jobs.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));

export function durationOf(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/** Of the platforms' answers to a run of writes: `rerun` when one was taken, else why not. */
export function rerunOutcome(
  statuses: (number | null)[],
): { outcome: CiRerunOutcome; rerun: number } | null {
  const taken = statuses.filter((s) => s !== null && s >= 200 && s < 300).length;
  if (taken > 0) return { outcome: "rerun", rerun: taken };
  if (statuses.some((s) => s === 403 || s === 401)) return { outcome: "refused", rerun: 0 };
  if (statuses.some((s) => s === null || s >= 500)) return null;
  return { outcome: "not_rerunnable", rerun: 0 };
}

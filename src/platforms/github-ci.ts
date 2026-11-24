import type { CiJobState, PullCiJob } from "../shared/index.js";
import { durationOf, type PullCi, rerunOutcome, sortJobs } from "./ci.js";
import { logTailAt } from "./ci-log.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformCall, platformJson, platformSend } from "./http.js";

// A GitHub pull request's CI: the check runs of its head (each name's
// latest) and its commit statuses. A check run of GitHub Actions is its
// job: its steps and log need the App's Actions read permission, and its
// re-run Actions write; any other app's run has only what it reported.

/** A head with more check runs than these pages hold is read in part. */
const MAX_PAGES = 3;
const PER_PAGE = 100;
/** Failed Actions jobs whose steps are read to name the one that failed. */
const MAX_STEP_READS = 5;
/** Workflow runs of one head run again at once. */
const MAX_RERUNS = 10;
/** A head's workflow runs, as one page lists them. */
const MAX_RUNS_BYTES = 4 * 1024 * 1024;
const ACTIONS = "github-actions";
const FAILED = new Set(["failure", "timed_out"]);

type CheckRun = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  details_url: string | null;
  app: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
};
type Status = {
  context: string;
  state: string;
  target_url: string | null;
  created_at: string;
  updated_at: string;
};
type Job = { steps?: { name: string; conclusion: string | null; number: number }[] };
type WorkflowRun = { id: number; head_sha: string; status: string; conclusion: string | null };

function stateOfRun(run: Pick<CheckRun, "status" | "conclusion">): CiJobState {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "passed";
  if (run.conclusion && FAILED.has(run.conclusion)) return "failed";
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion === "skipped") return "skipped";
  return "neutral";
}

const STATUS_STATES: Record<string, CiJobState> = {
  success: "passed",
  failure: "failed",
  error: "failed",
  pending: "pending",
};

const isActions = (run: Pick<CheckRun, "app">) => run.app?.slug === ACTIONS;

function runJob(run: CheckRun): PullCiJob {
  const state = stateOfRun(run);
  return {
    id: String(run.id),
    name: run.name,
    source: isActions(run) ? "github_actions" : "check_run",
    state,
    startedAt: run.started_at,
    finishedAt: run.completed_at,
    durationSeconds: durationOf(run.started_at, run.completed_at),
    url: run.html_url ?? run.details_url,
    failedStep: null,
    failureReason: null,
    hasLog: true,
    rerunnable: isActions(run) && state !== "pending",
  };
}

function statusJob(s: Status): PullCiJob {
  const state = STATUS_STATES[s.state] ?? "neutral";
  return {
    id: null,
    name: s.context,
    source: "status",
    state,
    startedAt: s.created_at,
    finishedAt: state === "pending" ? null : s.updated_at,
    durationSeconds: state === "pending" ? null : durationOf(s.created_at, s.updated_at),
    url: s.target_url,
    failedStep: null,
    failureReason: null,
    hasLog: false,
    rerunnable: false,
  };
}

const firstFailedStep = (job: Job | null) =>
  job?.steps
    ?.filter((s) => s.conclusion !== null && FAILED.has(s.conclusion))
    .sort((a, b) => a.number - b.number)[0]?.name ?? null;

export function githubCi(host: GithubHost): PullCi {
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  const get = <T>(token: string, url: string) =>
    platformCall<T>(url, { headers: githubHeaders(token) });
  const head = async (token: string, fullName: string, number: number) =>
    (await get<{ head: { sha: string } }>(token, `${repo(fullName)}/pulls/${number}`))?.head.sha ??
    null;
  const post = async (token: string, url: string) =>
    (await platformSend<unknown>(url, { method: "POST", headers: githubHeaders(token) }))?.status ??
    null;

  return {
    async jobs(token, fullName, number) {
      const sha = await head(token, fullName, number);
      if (!sha) return null;
      const runs: CheckRun[] = [];
      let more = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const listed = await get<{ total_count: number; check_runs: CheckRun[] }>(
          token,
          `${repo(fullName)}/commits/${sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`,
        );
        if (!listed) return null;
        runs.push(...listed.check_runs);
        more = listed.total_count > runs.length;
        if (listed.check_runs.length < PER_PAGE) break;
      }
      const combined = await get<{ statuses: Status[] }>(
        token,
        `${repo(fullName)}/commits/${sha}/status`,
      );
      const jobs = runs.map(runJob);
      const failedActions = jobs.filter(
        (j) => j.source === "github_actions" && j.state === "failed",
      );
      for (const job of failedActions.slice(0, MAX_STEP_READS)) {
        job.failedStep = firstFailedStep(
          await get<Job>(token, `${repo(fullName)}/actions/jobs/${job.id}`),
        );
      }
      jobs.push(...(combined?.statuses ?? []).map(statusJob));
      return { head: sha, pipeline: null, jobs: sortJobs(jobs), more };
    },

    async log(token, fullName, job) {
      const run = await get<CheckRun>(token, `${repo(fullName)}/check-runs/${job}`);
      if (!run) return null;
      const url = run.html_url ?? run.details_url;
      if (isActions(run)) {
        const text = await logTailAt(
          `${repo(fullName)}/actions/jobs/${run.id}/logs`,
          githubHeaders(token),
        );
        if (text?.trim()) return { name: run.name, url, source: "job_log", text };
      }
      const { title, summary, text } = run.output ?? {};
      const reported = [title, summary, text].filter((part) => part).join("\n");
      return reported.trim()
        ? { name: run.name, url, source: "check_output", text: reported }
        : { name: run.name, url, source: "none", text: "" };
    },

    async rerun(token, fullName, number, expected, job) {
      const sha = await head(token, fullName, number);
      if (!sha) return null;
      if (sha !== expected) return { outcome: "stale", rerun: 0 };
      if (job) {
        const run = await get<CheckRun>(token, `${repo(fullName)}/check-runs/${job}`);
        if (!run) return null;
        if (!isActions(run) || run.head_sha !== sha || run.status !== "completed") {
          return { outcome: "not_rerunnable", rerun: 0 };
        }
        return rerunOutcome([await post(token, `${repo(fullName)}/actions/jobs/${run.id}/rerun`)]);
      }
      const listed = await platformJson<{ workflow_runs: WorkflowRun[] }>(
        `${repo(fullName)}/actions/runs?head_sha=${sha}&per_page=${PER_PAGE}`,
        { headers: githubHeaders(token) },
        MAX_RUNS_BYTES,
      );
      if (!listed) return null;
      if (!listed.body) return listed.status === 403 ? { outcome: "refused", rerun: 0 } : null;
      const failed = listed.body.workflow_runs.filter(
        (r) =>
          r.head_sha === sha &&
          r.status === "completed" &&
          r.conclusion !== null &&
          FAILED.has(r.conclusion),
      );
      if (failed.length === 0) return { outcome: "nothing_failed", rerun: 0 };
      const statuses: (number | null)[] = [];
      for (const r of failed.slice(0, MAX_RERUNS)) {
        statuses.push(
          await post(token, `${repo(fullName)}/actions/runs/${r.id}/rerun-failed-jobs`),
        );
      }
      return rerunOutcome(statuses);
    },
  };
}

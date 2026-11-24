import type { CiJobState, PullCiJob } from "../shared/index.js";
import { durationOf, type PullCi, rerunOutcome, sortJobs } from "./ci.js";
import { logTailAt } from "./ci-log.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformJson, platformSend } from "./http.js";

// A GitLab merge request's CI: the jobs of its newest pipeline on the head
// (a retried job under its latest run), their traces, and their retry, all
// with the user's token (scope `api`).

/** A pipeline with more jobs than these pages hold is read in part. */
const MAX_PAGES = 3;
const PER_PAGE = 100;
/** Failed jobs of one head retried at once. */
const MAX_RETRIES = 10;
const MAX_JOB_BYTES = 256 * 1024;
const UNFINISHED = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);
const SETTLED: ReadonlySet<CiJobState> = new Set(["passed", "failed", "cancelled", "neutral"]);

type Pipeline = { id: number; sha: string; web_url?: string | null };
type Job = {
  id: number;
  name: string;
  status: string;
  allow_failure?: boolean;
  started_at: string | null;
  finished_at: string | null;
  duration?: number | null;
  web_url: string | null;
  failure_reason?: string | null;
  pipeline?: { sha?: string } | null;
};

function stateOf(job: Job): CiJobState {
  if (UNFINISHED.has(job.status)) return "pending";
  if (job.status === "success") return "passed";
  if (job.status === "failed") return job.allow_failure === true ? "neutral" : "failed";
  if (job.status === "canceled") return "cancelled";
  return "skipped";
}

function jobOf(job: Job): PullCiJob {
  const state = stateOf(job);
  return {
    id: String(job.id),
    name: job.name,
    source: "gitlab_job",
    state,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    durationSeconds:
      typeof job.duration === "number"
        ? Math.round(job.duration)
        : durationOf(job.started_at, job.finished_at),
    url: job.web_url,
    failedStep: null,
    failureReason: job.status === "failed" ? (job.failure_reason ?? null) : null,
    hasLog: job.started_at !== null,
    rerunnable: SETTLED.has(state),
  };
}

export function gitlabCi(origin: string): PullCi {
  const project = (fullName: string) => `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
  const get = <T>(token: string, url: string) =>
    platformCall<T>(url, { headers: gitlabHeaders(token) });
  const head = async (token: string, fullName: string, number: number) =>
    (await get<{ sha: string }>(token, mergeRequestUrl(origin, fullName, number)))?.sha ?? null;

  async function pipelineOf(token: string, fullName: string, number: number, sha: string) {
    const listed = await get<Pipeline[]>(
      token,
      `${mergeRequestUrl(origin, fullName, number)}/pipelines?per_page=${PER_PAGE}`,
    );
    return listed ? { pipeline: listed.find((p) => p.sha === sha) ?? null } : null;
  }

  async function jobsOf(token: string, fullName: string, pipeline: number) {
    const jobs: Job[] = [];
    let more = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await get<Job[]>(
        token,
        `${project(fullName)}/pipelines/${pipeline}/jobs?per_page=${PER_PAGE}&page=${page}`,
      );
      if (!batch) return null;
      jobs.push(...batch);
      more = batch.length === PER_PAGE;
      if (!more) break;
    }
    return { jobs, more };
  }

  const retry = async (token: string, fullName: string, job: number) =>
    (
      await platformSend<unknown>(`${project(fullName)}/jobs/${job}/retry`, {
        method: "POST",
        headers: gitlabHeaders(token),
      })
    )?.status ?? null;

  return {
    async jobs(token, fullName, number) {
      const sha = await head(token, fullName, number);
      if (!sha) return null;
      const found = await pipelineOf(token, fullName, number, sha);
      if (!found) return null;
      if (!found.pipeline) return { head: sha, pipeline: null, jobs: [], more: false };
      const listed = await jobsOf(token, fullName, found.pipeline.id);
      if (!listed) return null;
      return {
        head: sha,
        pipeline: { id: String(found.pipeline.id), url: found.pipeline.web_url ?? null },
        jobs: sortJobs(listed.jobs.map(jobOf)),
        more: listed.more,
      };
    },

    async log(token, fullName, job) {
      const read = await get<Job>(token, `${project(fullName)}/jobs/${job}`);
      if (!read) return null;
      const text = await logTailAt(
        `${project(fullName)}/jobs/${read.id}/trace`,
        gitlabHeaders(token),
      );
      return text?.trim()
        ? { name: read.name, url: read.web_url, source: "job_log", text }
        : { name: read.name, url: read.web_url, source: "none", text: "" };
    },

    async rerun(token, fullName, number, expected, job) {
      const sha = await head(token, fullName, number);
      if (!sha) return null;
      if (sha !== expected) return { outcome: "stale", rerun: 0 };
      if (job) {
        const read = await platformJson<Job>(
          `${project(fullName)}/jobs/${job}`,
          { headers: gitlabHeaders(token) },
          MAX_JOB_BYTES,
        );
        if (!read) return null;
        if (!read.body) return read.status === 404 ? { outcome: "not_rerunnable", rerun: 0 } : null;
        if (read.body.pipeline?.sha !== sha || !SETTLED.has(stateOf(read.body))) {
          return { outcome: "not_rerunnable", rerun: 0 };
        }
        return rerunOutcome([await retry(token, fullName, read.body.id)]);
      }
      const found = await pipelineOf(token, fullName, number, sha);
      if (!found) return null;
      if (!found.pipeline) return { outcome: "nothing_failed", rerun: 0 };
      const listed = await jobsOf(token, fullName, found.pipeline.id);
      if (!listed) return null;
      const failed = listed.jobs.filter((j) => stateOf(j) === "failed");
      if (failed.length === 0) return { outcome: "nothing_failed", rerun: 0 };
      const statuses: (number | null)[] = [];
      for (const j of failed.slice(0, MAX_RETRIES))
        statuses.push(await retry(token, fullName, j.id));
      return rerunOutcome(statuses);
    },
  };
}

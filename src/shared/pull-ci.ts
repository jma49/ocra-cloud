import type { CodePlatformKind } from "./domain.js";

// A pull request's CI on its head, read live from the platform as the user:
// GitHub's check runs and commit statuses, or the jobs of GitLab's newest
// pipeline on the head.

/**
 * `failed` is what fails the change: on GitHub a failure or a timeout, on
 * GitLab a failed job not allowed to fail (one allowed to is `neutral`).
 */
export type CiJobState = "pending" | "passed" | "failed" | "cancelled" | "skipped" | "neutral";

/** `check_run` is another app's GitHub check run; `status` a GitHub commit status. */
type CiJobSource = "github_actions" | "check_run" | "status" | "gitlab_job";

export type PullCiJob = {
  /** What `/ci/log` and `/ci/rerun` take as `job`; null for a commit status, which has neither. */
  id: string | null;
  name: string;
  source: CiJobSource;
  state: CiJobState;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  /** The platform's page for it. */
  url: string | null;
  /** The first failed step of a failed GitHub Actions job, when the platform listed its steps. */
  failedStep: string | null;
  /** GitLab's reason for a failed job (`script_failure`, `runner_system_failure`, ...). */
  failureReason: string | null;
  /** Whether `/ci/log` may answer a log or what the check reported. */
  hasLog: boolean;
  /** Whether `/ci/rerun` can run it again: an Actions job or a GitLab job that ended. */
  rerunnable: boolean;
};

export type PullCiView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  /** The head commit the jobs ran on, which a rerun names. */
  head: string;
  /** GitLab's pipeline the jobs are of; null on GitHub, or with no pipeline on the head. */
  pipeline: { id: string; url: string | null } | null;
  /** Failed first, then pending, then the rest, each by name. */
  jobs: PullCiJob[];
  /** True when the platform listed more than were read. */
  more: boolean;
};

/**
 * `job_log`: the end of the job's own log. `check_output`: what the check
 * reported of itself (another app's check run, or an Actions job whose log
 * the token could not read). `none`: neither; open `url`.
 */
export type CiLogSource = "job_log" | "check_output" | "none";

export type PullCiLogView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  job: string;
  name: string;
  url: string | null;
  source: CiLogSource;
  /**
   * The last lines, without timestamps, terminal sequences and control
   * characters, with secret-looking tokens redacted; "" with `none`.
   */
  log: string;
  /** Whether a secret-looking token was replaced. */
  redacted: boolean;
};

/**
 * `rerun`: the platform took it. `stale`: the head moved. `nothing_failed`:
 * no failed job to run again. `not_rerunnable`: the job is not one ocra can
 * run again (another app's check, a running one, one of another head).
 * `refused`: the platform refused the user (on GitHub, the App's Actions
 * write permission).
 */
export type CiRerunOutcome = "rerun" | "stale" | "nothing_failed" | "not_rerunnable" | "refused";

export type PullCiRerunAnswer = {
  outcome: CiRerunOutcome;
  /** GitHub workflow runs or GitLab jobs the platform took. */
  rerun: number;
};

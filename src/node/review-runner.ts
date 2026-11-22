import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loginOf } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { claimGenerate } from "../db/generate-jobs.js";
import { claimReply } from "../db/reply-jobs.js";
import { claimJob } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { CodePlatform } from "../platforms/platform.js";
import { startCliSession } from "../session.js";
import type { BotAccess, BotCredential, BotTokens } from "./bot-tokens.js";

// Runs the next queued review (ADR-0046, 4), answer to an @ocra comment, or
// request for tests or docstrings: clones the repository's default branch
// into a new directory, runs the released CLI there on the pull request
// (`ocra review … --no-repo-config`, `ocra reply` or `ocra generate`), signed in to this server as the enrolling account (its
// models, key, budget and rules, and the upload), and posting as the ocra
// bot. The directory and the session it was given are removed on every
// exit path. A failure is recorded on the job.

type ExecResult = { code: number | null };
/** Runs a command to its end; aborting the signal kills it with its children. */
export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
) => Promise<ExecResult>;

export type ReviewRunner = {
  db: Db;
  platforms: readonly CodePlatform[];
  bots: BotTokens;
  /** This server's own address, which the CLI signs in to. */
  publicUrl: string;
  exec?: Exec;
  /** The CLI's entry; the installed @open-cr-agent/cli by default. */
  cli?: string;
  leaseMs?: number;
  now?: () => Date;
};

type Failure = "repo_gone" | "platform_gone" | "no_bot" | "clone_failed" | "review_failed";
const RETRIED: ReadonlySet<Failure> = new Set(["clone_failed", "review_failed"]);

/** A review's run, clone included; the CLI's own run timeout is shorter. */
const LEASE_MS = 45 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;
/** The CLI's exit codes for a review it finished and posted: ok, blocking, incomplete. */
const REVIEWED = new Set([0, 1, 3]);
/** `ocra reply` answered, or found nothing to answer. */
const REPLIED = new Set([0]);
/** An answer is one model call or a few: far shorter than a review. */
const REPLY_LEASE_MS = 10 * 60_000;
/** `ocra generate` committed, or found nothing to write. */
const GENERATED = new Set([0]);
/** A few model calls, one per file it writes for, and one commit. */
const GENERATE_LEASE_MS = 20 * 60_000;

class JobFailure extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}

type Job = {
  id: string;
  accountId: string;
  reviewRepoId: string;
  attempts: number;
  leaseUntil: Date;
};
type Records = {
  finish(id: string, attempts: number, now: Date): Promise<unknown>;
  release(
    id: string,
    attempts: number,
    error: string,
    retryAt: Date | null,
    now: Date,
  ): Promise<unknown>;
};

/** Runs the job's CLI command and records how it went, retrying what may pass next time. */
async function runJob(runner: ReviewRunner, job: Job, records: Records, command: Command) {
  const now = runner.now ?? (() => new Date());
  const signal = AbortSignal.timeout(Math.max(job.leaseUntil.getTime() - now().getTime(), 0));
  try {
    await inCheckout(runner, job, command, signal);
    await records.finish(job.id, job.attempts, now());
  } catch (e) {
    const reason = e instanceof JobFailure ? e.reason : "review_failed";
    const retry = RETRIED.has(reason) && job.attempts < MAX_ATTEMPTS;
    logError("review_job_failed", { job: job.id, reason, error: errorName(e), retry });
    const retryAt = retry ? new Date(now().getTime() + RETRY_AFTER_MS * job.attempts) : null;
    await records.release(job.id, job.attempts, reason, retryAt, now());
  }
}

/** Runs the next due review; false when there was none. */
export async function runNextReview(runner: ReviewRunner): Promise<boolean> {
  const now = runner.now ?? (() => new Date());
  const job = await claimJob(runner.db, now(), runner.leaseMs ?? LEASE_MS);
  if (!job) return false;
  const jobs = scoped(runner.db, job.accountId).autoReview;
  await runJob(
    runner,
    job,
    {
      finish: (id, attempts, at) => jobs.finishJob(id, attempts, null, at),
      release: (id, attempts, error, retryAt, at) =>
        jobs.releaseJob(id, attempts, error, retryAt, at),
    },
    {
      args: (platform, fullName, config) => [
        "review",
        ...pull(platform, fullName, job.number),
        "--publish",
        "--no-repo-config",
        "--config",
        config,
      ],
      ok: REVIEWED,
    },
  );
  return true;
}

/** Runs the next due answer to an @ocra comment; false when there was none. */
export async function runNextReply(runner: ReviewRunner): Promise<boolean> {
  const now = runner.now ?? (() => new Date());
  const job = await claimReply(runner.db, now(), REPLY_LEASE_MS);
  if (!job) return false;
  await runJob(runner, job, scoped(runner.db, job.accountId).replies, {
    args: (platform, fullName, config) => [
      "reply",
      ...pull(platform, fullName, job.number),
      "--comment",
      job.commentId,
      ...(job.inline ? ["--inline"] : []),
      "--config",
      config,
    ],
    ok: REPLIED,
  });
  return true;
}

/** Runs the next due request for tests or docstrings; false when there was none. */
export async function runNextGeneration(runner: ReviewRunner): Promise<boolean> {
  const now = runner.now ?? (() => new Date());
  const job = await claimGenerate(runner.db, now(), GENERATE_LEASE_MS);
  if (!job) return false;
  await runJob(runner, job, scoped(runner.db, job.accountId).generations, {
    args: (platform, fullName, config) => [
      "generate",
      job.kind,
      ...pull(platform, fullName, job.number),
      "--config",
      config,
    ],
    ok: GENERATED,
    access: "commit",
  });
  return true;
}

/** What to run in the checkout: the CLI's arguments, its exit codes that mean done, and the bot's access. */
type Command = {
  args: (platform: CodePlatform, fullName: string, config: string) => string[];
  ok: ReadonlySet<number>;
  access?: BotAccess;
};

/** Clones the job's repository and runs the command there, signed in and posting as the bot. */
async function inCheckout(runner: ReviewRunner, job: Job, command: Command, signal: AbortSignal) {
  const data = scoped(runner.db, job.accountId);
  const repo = await data.get("reviewRepos", job.reviewRepoId);
  if (!repo) throw new JobFailure("repo_gone");
  const platform = runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) throw new JobFailure("platform_gone");
  const bot = await runner.bots.forRepo(repo.platform, repo.fullName, command.access);
  if (!bot) throw new JobFailure("no_bot");
  const exec = runner.exec ?? spawnExec;
  const dir = await mkdtemp(join(tmpdir(), "ocra-review-"));
  const sessionId = crypto.randomUUID();
  try {
    const home = join(dir, "home");
    const checkout = join(dir, "repo");
    await signIn(runner, job.accountId, sessionId, home);
    const origin = repoUrl(platform, repo.fullName);
    const auth = gitAuth(platform, bot);
    const cloned = await exec("git", ["clone", "--quiet", "--no-tags", "--", origin, checkout], {
      cwd: dir,
      env: { ...baseEnv(home), ...gitConfigEnv(platform, auth) },
      signal,
    });
    if (cloned.code !== 0) throw new JobFailure("clone_failed");
    // ocra fetches the pull request's commits with the checkout's credentials, as in CI.
    await appendFile(
      join(checkout, ".git", "config"),
      `[http "https://${platform.host}/"]\n\textraHeader = ${auth}\n`,
    );
    const config = join(dir, "ocra.json");
    await writeFile(config, JSON.stringify(bot.login ? { github: { botLogin: bot.login } } : {}));
    const args = command.args(platform, repo.fullName, config);
    const ran = await exec(process.execPath, [runner.cli ?? installedCli(), ...args], {
      cwd: checkout,
      env: { ...baseEnv(home), OCRA_CLOUD_URL: runner.publicUrl, ...botEnv(platform, bot) },
      signal,
    });
    if (ran.code === null || !command.ok.has(ran.code)) throw new JobFailure("review_failed");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await data.remove("sessions", sessionId).catch(() => {});
  }
}

/** A CLI session of the account, written where the CLI reads it; removed after the run. */
async function signIn(runner: ReviewRunner, accountId: string, sessionId: string, home: string) {
  const tokens = await startCliSession(runner.db, accountId, "auto review", sessionId);
  const config = join(home, ".config", "ocra");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(
    join(config, "credentials.json"),
    JSON.stringify({
      server: new URL(runner.publicUrl).origin,
      login: (await loginOf(runner.db, accountId)) ?? "",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      lifetime_ms: tokens.expires_in * 1000,
    }),
    { mode: 0o600 },
  );
}

const pull = (platform: CodePlatform, fullName: string, number: number) =>
  platform.kind === "github"
    ? ["--pr", String(number), "--repo", fullName]
    : ["--mr", String(number), "--project", fullName];

const repoUrl = (platform: CodePlatform, fullName: string) =>
  `https://${platform.host}/${fullName.split("/").map(encodeURIComponent).join("/")}.git`;

/** HTTP basic auth as each platform names a token's user. */
const gitAuth = (platform: CodePlatform, bot: BotCredential) =>
  `Authorization: Basic ${Buffer.from(
    `${platform.kind === "github" ? "x-access-token" : "oauth2"}:${bot.token}`,
  ).toString("base64")}`;

// Given in the environment, not the command line, where any process could read it.
const gitConfigEnv = (platform: CodePlatform, auth: string) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `http.https://${platform.host}/.extraHeader`,
  GIT_CONFIG_VALUE_0: auth,
});

const botEnv = (platform: CodePlatform, bot: BotCredential): Record<string, string> =>
  platform.kind === "github"
    ? { GITHUB_TOKEN: bot.token }
    : { GITLAB_TOKEN: bot.token, CI_API_V4_URL: `https://${platform.host}/api/v4` };

/** Only what git and the CLI need: no secret of this server reaches the child. */
const baseEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
});

function installedCli(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@open-cr-agent/cli/package.json");
  const { bin } = require(manifest) as { bin: { ocra: string } };
  return join(dirname(manifest), bin.ocra);
}

/** spawn in its own process group, so that an abort kills what it started too. */
const spawnExec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // The Worker's typing of process.env names its bindings; a child gets none of them.
      env: options.env as unknown as NodeJS.ProcessEnv,
      stdio: "ignore",
      detached: true,
    });
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    options.signal.addEventListener("abort", kill, { once: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      options.signal.removeEventListener("abort", kill);
      resolve({ code });
    });
  });

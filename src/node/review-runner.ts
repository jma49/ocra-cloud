import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Assignment,
  assign,
  type RunFailure,
  settle,
  type WorkKind,
  type WorkSource,
} from "../auto-review/work.js";
import { errorName, logError } from "../log.js";
import type { BotCredential } from "../platforms/bot.js";
import { githubHost } from "../platforms/github-host.js";

// The machine's half of a hosted job (ADR-0046, 4): clones the repository's
// default branch into a new directory and runs the released CLI there on
// the pull request (`ocra review … --no-repo-config`, `ocra reply` or
// `ocra generate`), signed in to the server as the enrolling account (its
// models, key, budget and rules, and the upload), and posting as the ocra
// bot. The directory is removed on every exit path. What to run comes from
// the server's half (src/auto-review/work.ts), which records how it went.

type ExecResult = { code: number | null };
/** Runs a command to its end; aborting the signal kills it with its children. */
export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
) => Promise<ExecResult>;

export type Machine = {
  exec?: Exec;
  /** The CLI's entry; the installed @open-cr-agent/cli by default. */
  cli?: string;
};

export type ReviewRunner = WorkSource & Machine;

class RunFailed extends Error {
  constructor(
    readonly reason: RunFailure,
    /** What the command exited with; null when it was killed at the lease. */
    readonly code?: number | null,
  ) {
    super(reason);
  }
}

/** Runs the assignment to its end, or to its lease's; the failure it ended with, or null. */
export async function run(
  machine: Machine,
  work: Assignment,
  now = new Date(),
  stop?: AbortSignal,
): Promise<RunFailure | null> {
  const lease = AbortSignal.timeout(Math.max(work.leaseUntil.getTime() - now.getTime(), 0));
  const signal = stop ? AbortSignal.any([lease, stop]) : lease;
  try {
    await inCheckout(machine, work, signal);
    return null;
  } catch (e) {
    if (!(e instanceof RunFailed)) {
      logError("review_run_failed", { job: work.id, error: errorName(e) });
      return "review_failed";
    }
    logError("review_run_failed", { job: work.id, reason: e.reason, code: e.code ?? null });
    return e.reason;
  }
}

/** Runs the kind's next due job; false when there was none. */
async function runNext(runner: ReviewRunner, kind: WorkKind): Promise<boolean> {
  const work = await assign(runner, kind);
  if (!work) return false;
  if (work === "refused") return true;
  const now = runner.now ?? (() => new Date());
  await settle(runner, work, await run(runner, work, now()), now());
  return true;
}

export const runNextReview = (runner: ReviewRunner) => runNext(runner, "review");
/** An answer to an @ocra comment. */
export const runNextReply = (runner: ReviewRunner) => runNext(runner, "reply");
/** A request for tests or docstrings. */
export const runNextGeneration = (runner: ReviewRunner) => runNext(runner, "generate");

/** Clones the repository and runs the CLI there, signed in and posting as the bot. */
async function inCheckout(machine: Machine, work: Assignment, signal: AbortSignal) {
  const exec = machine.exec ?? spawnExec;
  const { repo, bot } = work;
  const dir = await mkdtemp(join(tmpdir(), "ocra-review-"));
  try {
    const home = join(dir, "home");
    const checkout = join(dir, "repo");
    const credentials = join(home, ".config", "ocra");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    await writeFile(join(credentials, "credentials.json"), JSON.stringify(work.credentials), {
      mode: 0o600,
    });
    await writeFile(join(credentials, "upload-salt"), `${work.uploadSalt}\n`, { mode: 0o600 });
    // The CLI sends findings only from a machine that agreed to, which `ocra
    // login` records there. This run's machine is the server, which keeps what
    // it is sent only while the account keeps hosted findings.
    await writeFile(join(credentials, "share-findings"), "on\n", { mode: 0o600 });
    const auth = gitAuth(repo.platform, bot);
    const cloned = await exec(
      "git",
      ["clone", "--quiet", "--no-tags", "--", repoUrl(repo.url, repo.fullName), checkout],
      { cwd: dir, env: { ...baseEnv(home), ...gitConfigEnv(repo.url, auth) }, signal },
    );
    if (cloned.code !== 0) throw new RunFailed("clone_failed", cloned.code);
    // ocra fetches the pull request's commits with the checkout's credentials, as in CI.
    await appendFile(
      join(checkout, ".git", "config"),
      `[http "${repo.url}/"]\n\textraHeader = ${auth}\n`,
    );
    const config = join(dir, "ocra.json");
    await writeFile(config, JSON.stringify(work.config));
    const ran = await exec(
      process.execPath,
      [machine.cli ?? installedCli(), ...work.args, "--config", config],
      {
        cwd: checkout,
        env: { ...baseEnv(home), OCRA_CLOUD_URL: work.cloudUrl, ...botEnv(repo, bot) },
        signal,
      },
    );
    if (ran.code !== null && work.settled.includes(ran.code))
      throw new RunFailed("not_committed", ran.code);
    if (ran.code === null || !work.ok.includes(ran.code))
      throw new RunFailed("review_failed", ran.code);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const repoUrl = (url: string, fullName: string) =>
  `${url}/${fullName.split("/").map(encodeURIComponent).join("/")}.git`;

/** HTTP basic auth as each platform names a token's user. */
const gitAuth = (platform: Assignment["repo"]["platform"], bot: BotCredential) =>
  `Authorization: Basic ${Buffer.from(
    `${platform === "github" ? "x-access-token" : "oauth2"}:${bot.token}`,
  ).toString("base64")}`;

// Given in the environment, not the command line, where any process could read it.
const gitConfigEnv = (url: string, auth: string) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `http.${url}/.extraHeader`,
  GIT_CONFIG_VALUE_0: auth,
});

const botEnv = (repo: Assignment["repo"], bot: BotCredential): Record<string, string> =>
  repo.platform === "github"
    ? { GITHUB_TOKEN: bot.token, GITHUB_API_URL: githubHost(repo.url).api }
    : { GITLAB_TOKEN: bot.token, CI_API_V4_URL: `${repo.url}/api/v4` };

/**
 * How this host reaches the company's network, which git and the CLI need
 * too: its certificate authorities and its proxy.
 */
const NETWORK = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

const networkEnv = (): Record<string, string> =>
  Object.fromEntries(
    NETWORK.flatMap((name) => {
      const value = (process.env as Record<string, string | undefined>)[name];
      return value ? [[name, value]] : [];
    }),
  );

/** Only what git and the CLI need: no secret of this server reaches the child. */
const baseEnv = (home: string): Record<string, string> => ({
  ...networkEnv(),
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
});

function cliManifest() {
  const require = createRequire(import.meta.url);
  const path = require.resolve("@open-cr-agent/cli/package.json");
  return { path, ...(require(path) as { version: string; bin: { ocra: string } }) };
}

function installedCli(): string {
  const manifest = cliManifest();
  return join(dirname(manifest.path), manifest.bin.ocra);
}

/** The installed CLI's version, which a remote runner names itself with. */
export const installedCliVersion = () => cliManifest().version;

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

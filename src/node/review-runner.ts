import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixResultSchema } from "@open-cr-agent/cloud-contract";
import { type FixRan, settleFix } from "../auto-review/fix-work.js";
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
import { baseEnv, cloneAsBot, type Exec, spawnExec } from "./checkout.js";
import { keepReviewImpact, type ReviewGraphs, writeReviewGraph } from "./review-graph.js";

// The machine's half of a hosted job (ADR-0046, 4): clones the repository's
// default branch into a new directory and runs the released CLI there on
// the pull request (`ocra review … --no-repo-config`, `ocra reply`,
// `ocra generate`, `ocra learn feedback … --propose` or `ocra fix`), signed in to the server as the enrolling account (its
// models, key, budget and rules, and the upload), and posting as the ocra
// bot. The directory is removed on every exit path. What to run comes from
// the server's half (src/auto-review/work.ts), which records how it went.

export type Machine = {
  exec?: Exec;
  /** The CLI's entry; the installed @open-cr-agent/cli by default. */
  cli?: string;
  /** The code graphs its server keeps, where a review reads one (./review-graph.ts). */
  keptGraphs?: ReviewGraphs;
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

/** The most `ocra fix --json` prints: one line around a fix of at most MAX_FIELD characters, escaped. */
const MAX_FIX_ANSWER = 64 * 1024;

/** Runs the assignment to its end, or to its lease's; the failure it ended with, or null. */
export async function run(
  machine: Machine,
  work: Assignment,
  now = new Date(),
  stop?: AbortSignal,
): Promise<RunFailure | null> {
  const ran = await runCli(machine, work, now, stop);
  return "failure" in ran ? ran.failure : null;
}

/** Runs a fix's assignment: `ocra fix`'s answer, read from its last line of output, or the failure. */
export async function runFix(
  machine: Machine,
  work: Assignment,
  now = new Date(),
  stop?: AbortSignal,
): Promise<FixRan> {
  const ran = await runCli(machine, work, now, stop);
  if ("failure" in ran) return ran;
  const line = ran.stdout?.trim().split("\n").at(-1) ?? "";
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    json = undefined;
  }
  const answer = fixResultSchema.safeParse(json);
  if (answer.success) return { result: answer.data };
  logError("fix_answer_unreadable", { job: work.id });
  return { failure: "review_failed" };
}

async function runCli(
  machine: Machine,
  work: Assignment,
  now: Date,
  stop: AbortSignal | undefined,
): Promise<{ failure: RunFailure } | { stdout: string | undefined }> {
  const lease = AbortSignal.timeout(Math.max(work.leaseUntil.getTime() - now.getTime(), 0));
  const signal = stop ? AbortSignal.any([lease, stop]) : lease;
  try {
    return { stdout: await inCheckout(machine, work, signal) };
  } catch (e) {
    if (!(e instanceof RunFailed)) {
      logError("review_run_failed", { job: work.id, error: errorName(e) });
      return { failure: "review_failed" };
    }
    logError("review_run_failed", { job: work.id, reason: e.reason, code: e.code ?? null });
    return { failure: e.reason };
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
/** A pull request's declined findings, drafted into learnings. */
export const runNextLearning = (runner: ReviewRunner) => runNext(runner, "learn");

/** A fix asked for a stored finding. */
export async function runNextFix(runner: ReviewRunner): Promise<boolean> {
  const work = await assign(runner, "fix");
  if (!work) return false;
  if (work === "refused") return true;
  const now = runner.now ?? (() => new Date());
  await settleFix(runner, work, await runFix(runner, work, now()), now());
  return true;
}

/**
 * Clones the repository and runs the CLI there, signed in and posting as
 * the bot; what a fix's run printed.
 */
async function inCheckout(
  machine: Machine,
  work: Assignment,
  signal: AbortSignal,
): Promise<string | undefined> {
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
    const cloned = await cloneAsBot(exec, { repo, bot, dir, home, checkout }, signal);
    if (cloned !== 0) throw new RunFailed("clone_failed", cloned);
    const kept = work.graph && machine.keptGraphs && { graphs: machine.keptGraphs, at: work.graph };
    const graph = kept
      ? await writeReviewGraph(kept, work, { checkout, home }, join(dir, "graph.json"), signal)
      : undefined;
    const config = join(dir, "ocra.json");
    await writeFile(config, JSON.stringify(work.config));
    // Beside the checkout, never in it: nothing of the run is left in the repository.
    const finding = work.finding && join(dir, "finding.json");
    if (finding) await writeFile(finding, JSON.stringify(work.finding), { mode: 0o600 });
    const ran = await exec(
      process.execPath,
      [
        machine.cli ?? installedCli(),
        ...work.args,
        ...(graph ? ["--graph", graph.file] : []),
        ...(finding ? ["--finding", finding] : []),
        "--config",
        config,
      ],
      {
        cwd: checkout,
        env: { ...baseEnv(home), OCRA_CLOUD_URL: work.cloudUrl, ...botEnv(repo, bot) },
        signal,
        ...(finding ? { stdout: true as const, stdoutLimit: MAX_FIX_ANSWER } : {}),
      },
    );
    if (ran.code !== null && work.settled.includes(ran.code))
      throw new RunFailed("not_committed", ran.code);
    if (ran.code === null || !work.ok.includes(ran.code))
      throw new RunFailed("review_failed", ran.code);
    if (kept && graph) await keepReviewImpact(kept, work, { checkout, home }, graph);
    return ran.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const botEnv = (repo: Assignment["repo"], bot: BotCredential): Record<string, string> =>
  repo.platform === "github"
    ? { GITHUB_TOKEN: bot.token, GITHUB_API_URL: githubHost(repo.url).api }
    : { GITLAB_TOKEN: bot.token, CI_API_V4_URL: `${repo.url}/api/v4` };

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

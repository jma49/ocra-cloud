import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildFailure } from "../graph/runner.js";
import type { GraphAssignment } from "../graph/runner-api.js";
import { errorName, logError } from "../log.js";
import { baseEnv, cloneAsBot, type Exec, spawnExec } from "./checkout.js";
import { type GitRead, localGraph } from "./local-graph.js";
import type { RunnerGraphs } from "./runner-graphs.js";

// The machine's half of a remote graph build (src/graph/runner-api.ts): a
// clone without a working tree, the commit's graph built from its objects
// starting from the graph the server keeps, and the new one sent back. The
// directory is removed on every exit path.

export type GraphMachine = { exec?: Exec; git?: GitRead; graphs: RunnerGraphs };

/** Builds the assignment's graph to its end, or to its lease's, and reports how it went. */
export async function runGraphBuild(
  machine: GraphMachine,
  work: GraphAssignment,
  now = new Date(),
  stop?: AbortSignal,
): Promise<BuildFailure | null> {
  const lease = AbortSignal.timeout(Math.max(work.leaseUntil.getTime() - now.getTime(), 0));
  const signal = stop ? AbortSignal.any([lease, stop]) : lease;
  const failure = await inClone(machine, work, signal).catch((e): BuildFailure => {
    logError("graph_job_failed", { build: work.id, error: errorName(e) });
    return "build_failed";
  });
  if (failure) await machine.graphs.fail(work, failure);
  return failure;
}

async function inClone(
  machine: GraphMachine,
  work: GraphAssignment,
  signal: AbortSignal,
): Promise<BuildFailure | null> {
  const exec = machine.exec ?? spawnExec;
  const { repo, bot } = work;
  const dir = await mkdtemp(join(tmpdir(), "ocra-graph-"));
  try {
    const home = join(dir, "home");
    const checkout = join(dir, "repo");
    const clone = { repo, bot, dir, home, checkout };
    if ((await cloneAsBot(exec, clone, signal, ["--no-checkout"])) !== 0) return "clone_failed";
    const env = baseEnv(home);
    const held = await exec("git", ["cat-file", "-e", `${work.commit}^{commit}`], {
      cwd: checkout,
      env,
      signal,
    });
    // A commit pushed after the clone began, or since rewritten away, is not in it: fetched by id.
    const fetched =
      held.code === 0
        ? held
        : await exec(
            "git",
            ["fetch", "--quiet", "--no-tags", "--end-of-options", "origin", work.commit],
            { cwd: checkout, env, signal },
          );
    if (fetched.code !== 0) return "clone_failed";
    const previous = await machine.graphs.newest(work.accountId, work.graphRepoId, signal);
    const built = await localGraph({ checkout, home }, work.commit, previous, signal, machine.git);
    await machine.graphs.finish(work, built);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

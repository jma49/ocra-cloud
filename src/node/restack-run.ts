import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorName, logError } from "../log.js";
import { isCommit, safeBranch } from "../stack-merge/restack.js";
import {
  assignRestack,
  type RestackAssignment,
  type RestackResult,
  type RestackSource,
  settleRestack,
} from "../stack-merge/restack-work.js";
import { baseEnv, cloneAsBot, type Exec, spawnExec } from "./checkout.js";

// The machine's half of a restack (src/stack-merge/restack.ts): a clone as
// the bot, the pull request's head rebased with
// `git rebase --onto <new base> <old parent head>`, and a push with a lease
// on the head it had, so a branch someone pushed to meanwhile is left as it
// is. Nothing of the repository runs: no hook (core.hooksPath is
// /dev/null), no filter, merge or diff driver (none is configured: the
// system's and the user's git configuration are not read), no checkout
// filter on clone. The directory is removed on every exit path.

/** Options every git command of a restack runs with, ahead of its own. */
const SAFE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "rebase.autoSquash=false",
  "-c",
  "rebase.autoStash=false",
  "-c",
  "rebase.updateRefs=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "advice.detachedHead=false",
];

class Failed extends Error {}

/** Runs the restack to its end, or to its lease's: what it found, or the failure to retry. */
export async function runRestack(
  exec: Exec,
  work: RestackAssignment,
  now = new Date(),
  stop?: AbortSignal,
): Promise<RestackResult | { failure: "clone_failed" | "review_failed" }> {
  const lease = AbortSignal.timeout(Math.max(work.leaseUntil.getTime() - now.getTime(), 0));
  const signal = stop ? AbortSignal.any([lease, stop]) : lease;
  const { restack } = work;
  // What the server sent is checked again here, where it reaches git's command line.
  const valid =
    safeBranch(restack.branch) &&
    safeBranch(restack.onto.branch) &&
    isCommit(restack.head) &&
    isCommit(restack.upstream) &&
    (restack.onto.commit === null || isCommit(restack.onto.commit));
  if (!valid) return { failure: "review_failed" };
  const dir = await mkdtemp(join(tmpdir(), "ocra-restack-"));
  try {
    return await inClone(exec, work, dir, signal);
  } catch (e) {
    if (e instanceof Failed) return { failure: "clone_failed" };
    logError("restack_run_failed", { job: work.id, error: errorName(e) });
    return { failure: "review_failed" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function inClone(
  exec: Exec,
  work: RestackAssignment,
  dir: string,
  signal: AbortSignal,
): Promise<RestackResult> {
  const { restack, repo, bot } = work;
  const home = join(dir, "home");
  const checkout = join(dir, "repo");
  await mkdir(home, { recursive: true });
  const cloned = await cloneAsBot(exec, { repo, bot, dir, home, checkout }, signal, [
    "--no-checkout",
    "--filter=blob:none",
  ]);
  if (cloned !== 0) throw new Failed();
  const name = bot.login ?? "ocra";
  const env = {
    ...baseEnv(home),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name.replace(/[^\w.[\]-]/g, "")}@users.noreply.invalid`,
  };
  const git = (args: string[], read?: true) =>
    exec("git", [...SAFE, ...args], {
      cwd: checkout,
      env,
      signal,
      ...(read ? { stdout: true as const } : {}),
    });
  const commitOf = async (rev: string) => {
    const read = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], true);
    return read.code === 0 ? read.stdout?.trim() : undefined;
  };
  const ok = async (args: string[]) => (await git(args)).code === 0;
  const remote = `refs/remotes/origin/${restack.branch}`;
  if ((await commitOf(remote)) !== restack.head) return { outcome: "lease_lost" };
  const onto = restack.onto.commit ?? `refs/remotes/origin/${restack.onto.branch}`;
  // The layer below moved again since it was restacked: its own restack, or a person, follows.
  if (!(await commitOf(onto))) return { outcome: "lease_lost" };
  // Branched from an older head of the layer below: only its author knows what to keep.
  if (!(await ok(["merge-base", "--is-ancestor", restack.upstream, restack.head]))) {
    return { outcome: "conflict" };
  }
  // Merged with a merge commit: the new base holds the old commits already.
  if (await ok(["merge-base", "--is-ancestor", restack.upstream, onto])) {
    return { outcome: "skipped", reason: "up_to_date" };
  }
  if (!(await ok(["checkout", "--quiet", "--detach", restack.head]))) throw new Failed();
  if (!(await ok(["rebase", "--quiet", "--no-autosquash", "--onto", onto, restack.upstream]))) {
    await git(["rebase", "--abort"]);
    return { outcome: "conflict" };
  }
  const rebased = await commitOf("HEAD");
  if (!rebased) throw new Error("restack_no_head");
  if (rebased === restack.head) return { outcome: "skipped", reason: "up_to_date" };
  const ref = `refs/heads/${restack.branch}`;
  const pushed = await ok([
    "push",
    "--quiet",
    "--no-verify",
    `--force-with-lease=${ref}:${restack.head}`,
    "origin",
    `${rebased}:${ref}`,
  ]);
  if (pushed) return { outcome: "restacked", head: rebased };
  // Refused: by the lease when the branch moved, by the platform otherwise.
  await git(["fetch", "--quiet", "--no-tags", "origin", `+${ref}:${remote}`]);
  return (await commitOf(remote)) === restack.head
    ? { outcome: "skipped", reason: "push_refused" }
    : { outcome: "lease_lost" };
}

/** Runs the next due restack in this process; false when there was none. */
export async function runNextRestack(runner: RestackSource & { exec?: Exec }): Promise<boolean> {
  const work = await assignRestack(runner);
  if (!work) return false;
  if (work === "refused") return true;
  const now = runner.now ?? (() => new Date());
  const ran = await runRestack(runner.exec ?? spawnExec, work, now());
  await settleRestack(runner, work, ran, now());
  return true;
}

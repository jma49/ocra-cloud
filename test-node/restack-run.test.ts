import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Exec, spawnExec } from "../src/node/checkout.js";
import { runRestack } from "../src/node/restack-run.js";
import type { RestackAssignment } from "../src/stack-merge/restack-work.js";

// A restack's run on a real repository: the child rebased onto the squash
// that landed its parent, force-pushed only while its branch is where it
// was, nothing pushed on a conflict, and git run with no hook of anyone's.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ocra-restack-run-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Dev",
      "-c",
      "user.email=dev@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();

type Repo = {
  url: string;
  bare: string;
  work: string;
  commit: (files: Record<string, string>, message: string) => Promise<string>;
};

/** octo/api on disk: main, step-1 on it, step-2 on step-1, all pushed. */
async function stacked(): Promise<Repo & { parent: string; child: string; main: string }> {
  const dir = join(root, `r${n++}`);
  const bare = join(dir, "octo", "api.git");
  const work = join(dir, "work");
  await mkdir(work, { recursive: true });
  await mkdir(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "remote", "add", "origin", bare);
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) await writeFile(join(work, path), text);
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "--message", message);
    return git(work, "rev-parse", "HEAD");
  };
  const main = await commit({ "a.txt": "one\n", "b.txt": "two\n" }, "start");
  git(work, "checkout", "--quiet", "-b", "step-1");
  const parent = await commit({ "a.txt": "one, changed\n" }, "parent");
  git(work, "checkout", "--quiet", "-b", "step-2");
  const child = await commit({ "c.txt": "three\n" }, "child");
  git(work, "push", "--quiet", "origin", "main", "step-1", "step-2");
  return { url: `file://${dir}`, bare, work, commit, parent, child, main };
}

/** The parent squashed onto main, as a squash merge leaves it. */
async function squash(repo: Repo, extra: Record<string, string> = {}) {
  git(repo.work, "checkout", "--quiet", "main");
  await writeFile(join(repo.work, "a.txt"), "one, changed\n");
  const landed = await repo.commit(extra, "parent (#1)");
  git(repo.work, "push", "--quiet", "origin", "main");
  return landed;
}

const job = (repo: Repo, head: string, upstream: string): RestackAssignment => ({
  id: "job",
  accountId: "account",
  attempts: 1,
  leaseUntil: new Date(Date.now() + 60_000),
  repo: { platform: "github", url: repo.url, fullName: "octo/api" },
  bot: { token: "ghs_bot", login: "ocra-review[bot]" },
  restack: {
    branch: "step-2",
    head,
    onto: { branch: "main", commit: null },
    upstream,
    fork: false,
  },
});

/** One asked for by hand: step-2 onto step-1 as it is now, with no old head of step-1 recorded. */
const asked = (repo: Repo, head: string, parentHead: string): RestackAssignment => {
  const base = job(repo, head, parentHead);
  return {
    ...base,
    restack: {
      ...base.restack,
      onto: { branch: "step-1", commit: parentHead },
      fork: true,
    },
  };
};

const remoteHead = (repo: Repo, branch: string) => git(repo.bare, "rev-parse", branch);

describe("a restack's run", () => {
  let calls: string[][];
  const exec: Exec = (command, args, options) => {
    calls.push([command, ...args]);
    return spawnExec(command, args, options);
  };
  beforeEach(() => {
    calls = [];
  });

  it("rebases the child onto the squash that landed its parent and force-pushes it", async () => {
    const repo = await stacked();
    const landed = await squash(repo);
    const ran = await runRestack(exec, job(repo, repo.child, repo.parent));
    expect(ran).toMatchObject({ outcome: "restacked" });
    const pushed = "head" in ran ? ran.head : "";
    expect(remoteHead(repo, "step-2")).toBe(pushed);
    // Only the child's own commit, on the trunk: its parent's original is gone.
    expect(git(repo.bare, "rev-list", `${landed}..step-2`).split("\n")).toEqual([pushed]);
    expect(git(repo.bare, "rev-parse", "step-2^")).toBe(landed);
    expect(git(repo.bare, "log", "-1", "--format=%cn %an", "step-2")).toBe("ocra-review[bot] Dev");
    // Every git command after the clone runs with no hook and no driver of the repository's.
    const after = calls.filter((c) => c[1] !== "clone");
    expect(after.length).toBeGreaterThan(3);
    for (const c of after) expect(c.slice(1, 3)).toEqual(["-c", "core.hooksPath=/dev/null"]);
    expect(calls.find((c) => c.includes("push"))).toContain(
      "--force-with-lease=refs/heads/step-2:" + repo.child,
    );
    // The token never reaches a command line.
    expect(JSON.stringify(calls)).not.toContain("ghs_bot");
  });

  it("pushes nothing when the branch moved since it was queued", async () => {
    const repo = await stacked();
    await squash(repo);
    git(repo.work, "checkout", "--quiet", "step-2");
    const moved = await repo.commit({ "d.txt": "four\n" }, "more");
    git(repo.work, "push", "--quiet", "origin", "step-2");
    expect(await runRestack(exec, job(repo, repo.child, repo.parent))).toEqual({
      outcome: "lease_lost",
    });
    expect(remoteHead(repo, "step-2")).toBe(moved);
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("pushes nothing on a conflict, and leaves the branch for a local restack", async () => {
    const repo = await stacked();
    git(repo.work, "checkout", "--quiet", "step-2");
    const child = await repo.commit({ "b.txt": "two, the child's\n" }, "child edits b");
    git(repo.work, "push", "--quiet", "origin", "step-2");
    await squash(repo, { "b.txt": "two, the trunk's\n" });
    expect(await runRestack(exec, job(repo, child, repo.parent))).toEqual({
      outcome: "conflict",
    });
    expect(remoteHead(repo, "step-2")).toBe(child);
  });

  it("has nothing to do after a merge commit, which holds the parent's commits", async () => {
    const repo = await stacked();
    git(repo.work, "checkout", "--quiet", "main");
    git(repo.work, "merge", "--quiet", "--no-ff", "--message", "Merge #1", "step-1");
    git(repo.work, "push", "--quiet", "origin", "main");
    expect(await runRestack(exec, job(repo, repo.child, repo.parent))).toEqual({
      outcome: "skipped",
      reason: "up_to_date",
    });
    expect(remoteHead(repo, "step-2")).toBe(repo.child);
  });

  it("refuses a branch that git would read as an option, before any command", async () => {
    const repo = await stacked();
    const bad = job(repo, repo.child, repo.parent);
    bad.restack.branch = "--upload-pack=touch";
    expect(await runRestack(exec, bad)).toEqual({ failure: "review_failed" });
    expect(calls).toEqual([]);
  });

  it("reports a clone that failed, to be tried again", async () => {
    const repo = await stacked();
    const gone = { ...job(repo, repo.child, repo.parent) };
    gone.repo = { ...gone.repo, fullName: "octo/missing" };
    expect(await runRestack(exec, gone)).toEqual({ failure: "clone_failed" });
  });
});

describe("a restack asked for by hand", () => {
  it("rebases the layer onto the new head of the one below, dropping what they share", async () => {
    const repo = await stacked();
    git(repo.work, "checkout", "--quiet", "step-1");
    const moved = await repo.commit({ "e.txt": "five\n" }, "parent, more");
    git(repo.work, "push", "--quiet", "origin", "step-1");
    const ran = await runRestack(spawnExec, asked(repo, repo.child, moved));
    expect(ran).toMatchObject({ outcome: "restacked" });
    const pushed = "head" in ran ? ran.head : "";
    expect(remoteHead(repo, "step-2")).toBe(pushed);
    expect(git(repo.bare, "rev-list", `${moved}..step-2`).split("\n")).toEqual([pushed]);
    expect(git(repo.bare, "rev-parse", "step-2^")).toBe(moved);
  });

  it("drops the parent's old commits when the parent was rewritten to the same change", async () => {
    const repo = await stacked();
    git(repo.work, "checkout", "--quiet", "step-1");
    git(repo.work, "commit", "--quiet", "--amend", "--message", "parent, reworded");
    const rewritten = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "push", "--quiet", "--force", "origin", "step-1");
    const ran = await runRestack(spawnExec, asked(repo, repo.child, rewritten));
    expect(ran).toMatchObject({ outcome: "restacked" });
    expect(git(repo.bare, "rev-list", `${rewritten}..step-2`).split("\n")).toHaveLength(1);
  });

  it("has nothing to do when the layer already holds the head below it", async () => {
    const repo = await stacked();
    expect(await runRestack(spawnExec, asked(repo, repo.child, repo.parent))).toEqual({
      outcome: "skipped",
      reason: "up_to_date",
    });
    expect(remoteHead(repo, "step-2")).toBe(repo.child);
  });

  it("pushes nothing on a conflict", async () => {
    const repo = await stacked();
    git(repo.work, "checkout", "--quiet", "step-2");
    const child = await repo.commit({ "b.txt": "two, the child's\n" }, "child edits b");
    git(repo.work, "checkout", "--quiet", "step-1");
    const moved = await repo.commit({ "b.txt": "two, the parent's\n" }, "parent edits b");
    git(repo.work, "push", "--quiet", "origin", "step-1", "step-2");
    expect(await runRestack(spawnExec, asked(repo, child, moved))).toEqual({ outcome: "conflict" });
    expect(remoteHead(repo, "step-2")).toBe(child);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitlabMerged, restackOnMerge } from "../src/stack-merge/hooks.js";
import { resetDb } from "./helpers.js";
import { history, mergedOne, setUp, turn } from "./restack-fakes.js";
import { github, layer, mergeOf, runner, sha, start } from "./stack-fakes.js";

// Restacking after a squash merge, where a repository turned it on: the
// pull requests moved off the merged one are queued, once per merge, to be
// rebased and force-pushed by the bot; off, they are only moved.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("restacking after a merge on the platform", () => {
  it("is off until the repository turns it on: the stacked ones are only moved", async () => {
    const fake = github([layer(1, "main", { state: "MERGED" }), layer(2, "step-1")]);
    const { a, data } = await setUp();
    expect(await history(a)).toEqual({ restack: false, jobs: [] });
    const repo = await data.get("reviewRepos", "r");
    expect(await restackOnMerge(runner(), repo as never, mergedOne as never)).toBe(1);
    expect(fake.pulls.get(2)?.base).toBe("main");
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues each one moved off the merged pull request once, onto its base, past its old head", async () => {
    github([
      layer(1, "main", { state: "MERGED" }),
      layer(2, "step-1"),
      layer(4, "step-1"),
      layer(3, "step-2"),
    ]);
    const { a, data } = await setUp();
    const res = await turn(a, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restack: true });
    const repo = await data.get("reviewRepos", "r");
    expect(mergedOne).toMatchObject({ headSha: sha(1), mergeCommit: mergeOf(1) });
    await restackOnMerge(runner(), repo as never, mergedOne as never);
    // The webhook delivered twice queues nothing more.
    await restackOnMerge(runner(), repo as never, mergedOne as never);
    const { restack, jobs } = await history(a);
    expect(restack).toBe(true);
    expect(jobs.map((j) => [j.number, j.parent, j.branch, j.onto, j.from, j.state]).sort()).toEqual(
      [
        [2, 1, "step-2", "main", sha(2), "queued"],
        [4, 1, "step-4", "main", sha(4), "queued"],
      ],
    );
    const kinds = (await data.list("auditEvents")).map((e) => e.kind);
    expect(kinds).toContain("auto_review.restack_changed");
  });

  it("is read with the head and merge commit GitLab names", () => {
    expect(
      gitlabMerged("Merge Request Hook", {
        object_attributes: {
          iid: 4,
          action: "merge",
          source_branch: "a",
          target_branch: "main",
          last_commit: { id: sha(4) },
          merge_commit_sha: null,
          squash_commit_sha: mergeOf(4),
        },
      }),
    ).toEqual({ number: 4, head: "a", base: "main", headSha: sha(4), mergeCommit: mergeOf(4) });
  });
});

describe("restacking in a stack merge", () => {
  it("queues the pull requests stacked off the chain, not the chain it merges itself", async () => {
    github([layer(1, "main"), layer(2, "step-1"), layer(5, "step-1")]);
    const { a } = await setUp();
    expect((await turn(a, true)).status).toBe(200);
    const { answer } = await start(2, a);
    expect(answer.job).toMatchObject({ state: "merged" });
    const { jobs } = await history(a);
    expect(jobs.map((j) => [j.number, j.parent, j.onto, j.from])).toEqual([[5, 1, "main", sha(5)]]);
  });
});

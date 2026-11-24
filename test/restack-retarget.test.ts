import { beforeEach, describe, expect, it } from "vitest";
import type { scoped } from "../src/db/scoped.js";
import { githubFields } from "../src/inbound/fields.js";
import { githubSteps } from "../src/inbound/steps.js";
import { moveGithubStacks, restackOnMerge } from "../src/stack-merge/hooks.js";
import { db, resetDb } from "./helpers.js";
import { history, mergedOne, setUp, turn } from "./restack-fakes.js";
import { github, layer, mergeOf, runner, sha } from "./stack-fakes.js";
import { rows } from "./table-rows.js";

// GitHub moves the pull requests stacked on a merged one itself when it
// deletes the merged head branch, sometimes before the merge's delivery is
// handled, which then finds none to move: each move's own delivery queues
// the restack, under the merge's key, so the two never queue it twice.

beforeEach(resetDb);

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

/** #1, from step-1 into main, as the index holds it merged. */
async function indexMerged(data: ReturnType<typeof scoped>, mergedAt = minutesAgo(1)) {
  await data.insert("pullIndex", {
    ...rows.pullIndex("p1"),
    reviewRepoId: "r",
    number: 1,
    state: "merged" as const,
    mergedAt,
    head: sha(1),
    headBranch: "step-1",
    baseBranch: "main",
  });
}

const edited = (number: number, from: string, base: string, headRepo: number | null = 1) => ({
  action: "edited",
  number,
  changes: { base: { ref: { from }, sha: { from: sha(1) } } },
  repository: { id: 1, full_name: "octo/api" },
  pull_request: {
    state: "open",
    head: {
      ref: `step-${number}`,
      sha: sha(number),
      repo: headRepo === null ? null : { id: headRepo },
    },
    base: { ref: base, repo: { id: 1 } },
  },
});

/** The repository enrolled as the deliveries name it, and the restack switch as given. */
async function enrolled(restack: boolean) {
  const { a, data } = await setUp();
  await data.update("reviewRepos", "r", { platformRepoId: "1" });
  if (restack) expect((await turn(a, true)).status).toBe(200);
  return { a, data };
}

const deliver = (body: unknown) => moveGithubStacks(runner(), "github.com", "pull_request", body);
const steps = (body: unknown) => githubSteps(db, "github.com", "pull_request", body);

describe("restacking a pull request GitHub moved off a merged one", () => {
  it("queues it onto the merged one's base when the merge's delivery found none to move", async () => {
    // GitHub already moved #2 to main when the branch went.
    github([layer(1, "main", { state: "MERGED" }), layer(2, "main")]);
    const { a, data } = await enrolled(true);
    await indexMerged(data);
    const repo = await data.get("reviewRepos", "r");
    expect(await restackOnMerge(runner(), repo as never, mergedOne as never)).toBe(0);
    expect((await history(a)).jobs).toEqual([]);
    const moved = edited(2, "step-1", "main");
    expect(await steps(moved)).toContain("intents");
    // What a retry keeps of the delivery is enough; delivered twice, it queues one.
    await deliver(githubFields(moved));
    await deliver(moved);
    const { jobs } = await history(a);
    expect(jobs.map((j) => [j.number, j.parent, j.branch, j.onto, j.from, j.state])).toEqual([
      [2, 1, "step-2", "main", sha(2), "queued"],
    ]);
  });

  it("queues nothing more for a move the merge's own delivery made and queued", async () => {
    github([layer(1, "main", { state: "MERGED" }), layer(2, "step-1")]);
    const { a, data } = await enrolled(true);
    await indexMerged(data);
    const repo = await data.get("reviewRepos", "r");
    expect(await restackOnMerge(runner(), repo as never, mergedOne as never)).toBe(1);
    await deliver(edited(2, "step-1", "main"));
    expect((await history(a)).jobs.map((j) => j.number)).toEqual([2]);
  });

  it("queues nothing where the repository has restacks off", async () => {
    github([layer(1, "main", { state: "MERGED" }), layer(2, "main")]);
    const { a, data } = await enrolled(false);
    await indexMerged(data);
    const moved = edited(2, "step-1", "main");
    expect(await steps(moved)).not.toContain("intents");
    await deliver(moved);
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues nothing for a move off a branch that did not merge lately", async () => {
    github([layer(1, "main", { state: "MERGED", mergedAt: minutesAgo(3 * 60) }), layer(2, "main")]);
    const { a, data } = await enrolled(true);
    await indexMerged(data, minutesAgo(3 * 60));
    // Neither the index nor the platform has it merged within the window.
    await deliver(edited(2, "step-1", "main"));
    await deliver(edited(2, "step-9", "main"));
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues nothing for a move onto another base than the merged one's", async () => {
    github([layer(1, "main", { state: "MERGED" }), layer(2, "release")]);
    const { a, data } = await enrolled(true);
    await indexMerged(data);
    // The index cannot tell where the merged one went: the platform's answer does.
    expect(await steps(edited(2, "step-1", "release"))).toContain("intents");
    await deliver(edited(2, "step-1", "release"));
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues nothing for a fork's pull request or an edit that kept the base", async () => {
    github([layer(1, "main", { state: "MERGED" }), layer(2, "main")]);
    const { a, data } = await enrolled(true);
    await indexMerged(data);
    await deliver(edited(2, "step-1", "main", 7));
    await deliver(edited(2, "step-1", "main", null));
    await deliver({ ...edited(2, "step-1", "main"), changes: {} });
    expect((await history(a)).jobs).toEqual([]);
  });

  it("queues it once when its move is handled before the merge's delivery indexed the merge", async () => {
    github([layer(1, "main", { state: "MERGED" }), layer(2, "main")]);
    const { a } = await enrolled(true);
    const moved = edited(2, "step-1", "main");
    expect(await steps(moved)).toContain("intents");
    await deliver(moved);
    const once = [[2, 1, "step-2", "main", sha(2), "queued"]];
    const jobs = async () =>
      (await history(a)).jobs.map((j) => [j.number, j.parent, j.branch, j.onto, j.from, j.state]);
    expect(await jobs()).toEqual(once);
    // The merge's own delivery comes next: #2 is already on main, and the key is the same.
    await deliver(mergedDelivery);
    await deliver(moved);
    expect(await jobs()).toEqual(once);
  });

  it("queues nothing from the platform's answer while the old base has an open pull request", async () => {
    github([
      layer(1, "main", { state: "MERGED" }),
      layer(5, "main", { head: "step-1" }),
      layer(2, "main"),
    ]);
    const { a } = await enrolled(true);
    await deliver(edited(2, "step-1", "main"));
    expect((await history(a)).jobs).toEqual([]);
  });
});

/** #1's merge, as GitHub delivers it. */
const mergedDelivery = {
  action: "closed",
  number: 1,
  repository: { id: 1, full_name: "octo/api" },
  pull_request: {
    merged: true,
    merge_commit_sha: mergeOf(1),
    head: { ref: "step-1", sha: sha(1) },
    base: { ref: "main" },
  },
};

import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import type { ReconciledPull } from "../src/platforms/reconcile.js";
import { mergeFacts } from "../src/pull-index/facts.js";
import { gitlabFacts } from "../src/pull-index/hooks.js";
import { indexReconciled } from "../src/pull-index/reconcile.js";
import { db, resetDb, signIn } from "./helpers.js";

// What feeds the inbox's index: the reconciliation's listings, webhooks
// (by the platform's update time, never back) and compare-and-set writes.

beforeEach(resetDb);

const HEAD = "a".repeat(40);

async function setUp() {
  const me = await signIn(42, "octo");
  const data = scoped(db, me.account.id);
  const id = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  return { data, id };
}

describe("the index's sources", () => {
  const reconciled = (n: number, over: Partial<ReconciledPull> = {}): ReconciledPull => ({
    number: n,
    title: `Change ${n}`,
    author: "ada",
    authorId: "5",
    draft: false,
    state: "open",
    openedAt: new Date("2026-11-10T10:00:00Z"),
    updatedAt: new Date("2026-11-20T10:00:00Z"),
    closedAt: null,
    asks: [{ team: false, id: "42", name: "octo" }],
    listed: {
      pullId: `PR_${n}`,
      url: `https://github.com/octo/api/pull/${n}`,
      authorAvatar: null,
      labels: [],
      assigneeIds: [],
      head: HEAD,
      branches: { head: "feat", base: "main" },
    },
    ...over,
  });

  it("fills from the reconciliation, closes what it no longer lists open, never regresses a newer row", async () => {
    const { data, id } = await setUp();
    const at = new Date("2026-11-23T00:00:00Z");
    const listing = (pulls: ReconciledPull[]) => ({ pulls, more: false });
    await indexReconciled(data, id, listing([]), listing([reconciled(1), reconciled(2)]), at);
    // A webhook newer than the next listing.
    const read = await data.pullIndex.of(id, 2);
    const newer = mergeFacts(read, {
      number: 2,
      changedAt: new Date("2026-11-22T10:00:00Z"),
      title: "renamed",
    });
    if (!newer) throw new Error("expected a change");
    await data.pullIndex.write(read, newer);
    await indexReconciled(
      data,
      id,
      listing([]),
      listing([reconciled(2, { title: "older listing" })]),
      at,
    );
    expect((await data.pullIndex.of(id, 1))?.state).toBe("closed");
    expect((await data.pullIndex.of(id, 2))?.title).toBe("renamed");
    expect((await data.get("reviewRepos", id))?.pullsIndexedAt).toEqual(at);
    // A listing cut short by its pages closes nothing and leaves the repository not fresh.
    await data.update("reviewRepos", id, { pullsIndexedAt: null });
    await indexReconciled(data, id, listing([]), { pulls: [], more: true }, at);
    expect((await data.pullIndex.of(id, 2))?.state).toBe("open");
    expect((await data.get("reviewRepos", id))?.pullsIndexedAt).toBeNull();
  });

  it("a write that read before another's changes nothing", async () => {
    const { data, id } = await setUp();
    const listing = { pulls: [reconciled(1)], more: false };
    await indexReconciled(data, id, { pulls: [], more: false }, listing, new Date());
    const read = await data.pullIndex.of(id, 1);
    const one = mergeFacts(read, { number: 1, changedAt: new Date("2026-11-21Z"), title: "a" });
    const two = mergeFacts(read, { number: 1, changedAt: new Date("2026-11-21Z"), draft: true });
    if (!one || !two) throw new Error("expected changes");
    expect(await data.pullIndex.write(read, one)).toBe(true);
    expect(await data.pullIndex.write(read, two)).toBe(false);
    expect(await data.pullIndex.of(id, 1)).toMatchObject({ title: "a", draft: false });
  });

  it("reads a GitLab merge request hook, its older time format included", () => {
    expect(
      gitlabFacts({
        user: { id: 7, username: "lab", avatar_url: null },
        object_attributes: {
          id: 900,
          iid: 4,
          title: "Draft: parser",
          url: "https://gitlab.example.com/g/p/-/merge_requests/4",
          state: "merged",
          draft: true,
          created_at: "2026-11-02 10:00:00 UTC",
          updated_at: "2026-11-03 11:00:00 UTC",
          author_id: 7,
          last_commit: { id: HEAD },
          source_branch: "feat",
          target_branch: "main",
          source_project_id: 3,
          target_project_id: 3,
        },
        labels: [{ title: "api" }],
        reviewers: [{ id: 8, username: "rev" }],
      }),
    ).toMatchObject({
      number: 4,
      pullId: "900",
      author: "lab",
      authorId: "7",
      draft: true,
      state: "merged",
      changedAt: new Date("2026-11-03T11:00:00Z"),
      mergedAt: new Date("2026-11-03T11:00:00Z"),
      labels: ["api"],
      head: HEAD,
      branches: { head: "feat", base: "main" },
      reviewerIds: ["8"],
    });
  });
});

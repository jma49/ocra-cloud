import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepGitlabFindingThread } from "../src/auto-review/finding-threads.js";
import { CallBudget } from "../src/calls.js";
import { scoped } from "../src/db/scoped.js";
import { reconcileReactions } from "../src/finding-reactions.js";
import { repoIdentity } from "../src/platforms/platform.js";
import { platformsOf } from "../src/platforms/registry.js";
import type { FindingInsightsView } from "../src/shared/index.js";
import { seed } from "./fix-fakes.js";
import { call, db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// The 👍 and 👎 people give ocra's comments of findings, read from the
// platform when the pull request's page loads, when a person writes in a
// GitLab thread, and in the daily reconciliation, are kept on the findings
// and counted by the insights: accepted is fixed or 👍, once a finding.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const FP = "0123456789abcdef";
const GRAPHQL = "https://api.github.com/graphql";
const COMMENTS =
  "https://api.github.com/repos/octo/api/pulls/7/comments?per_page=100&page=1&sort=created&direction=asc";
const identity = repoIdentity({ url: "https://github.com" }, "octo/api").toLowerCase();
const [github, gitlab] = (() => {
  const all = platformsOf(env, ORIGIN);
  return [all.find((p) => p.kind === "github"), all.find((p) => p.kind === "gitlab")];
})();

const noThreads = () =>
  Response.json({
    data: {
      repository: {
        pullRequest: {
          headRefOid: "a".repeat(40),
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });

/** A finding of octo/api#7 whose comment, 100, started a thread of an enrolled repository. */
async function onRecord(platform: "github" | "gitlab" = "github") {
  const { id, data } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
  const reviewRepoId = await data.insert("reviewRepos", {
    platform,
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  await data.findingThreads.start({
    reviewRepoId,
    repository: identity,
    number: 7,
    threadKey: platform === "github" ? "100" : "d1",
    fingerprint: FP,
    starterId: "900",
    commentId: "100",
  });
  const finding = async () => (await data.get("findings", id)) ?? undefined;
  return { data, reviewRepoId, finding };
}

describe("reactions on ocra's comments", () => {
  it("reads them when the pull request's page loads, then not again for a while", async () => {
    const reads: string[] = [];
    githubFake({
      extra: async (req) => {
        if (req.url === GRAPHQL) return noThreads();
        if (req.url === COMMENTS) {
          reads.push(req.url);
          return Response.json([
            { id: 99, reactions: { "+1": 5, "-1": 5 } },
            { id: 100, reactions: { "+1": 1, "-1": 2 } },
          ]);
        }
        return undefined;
      },
    });
    const a = await signInWithGithub();
    const { finding } = await onRecord();
    const load = () => a.send("/api/pulls/threads?platform=github&repo=octo/api&number=7");
    expect((await load()).status).toBe(200);
    expect(await finding()).toMatchObject({ thumbsUp: 1, thumbsDown: 2 });
    expect((await finding())?.reactionsReadAt).toBeInstanceOf(Date);
    await load();
    expect(reads).toHaveLength(1);
  });

  it("keeps a later read over an earlier one", async () => {
    await signIn(42, "octo");
    const { data, finding } = await onRecord();
    const on = { identity, number: 7, fingerprint: FP };
    await data.findingOutcomes.recordReactions(on, { up: 3, down: 0 }, new Date(2_000));
    await data.findingOutcomes.recordReactions(on, { up: 1, down: 4 }, new Date(1_000));
    expect(await finding()).toMatchObject({ thumbsUp: 3, thumbsDown: 0 });
  });

  it("reads a GitLab note's award emoji when a person writes in its discussion", async () => {
    await signIn(42, "octo");
    const { data, reviewRepoId, finding } = await onRecord("gitlab");
    const repo = await data.get("reviewRepos", reviewRepoId);
    if (!repo) throw new Error("no repository");
    const asked: string[] = [];
    const reply = {
      user: { id: 7, username: "rita" },
      object_attributes: {
        id: 101,
        note: "Not a bug.",
        noteable_type: "MergeRequest",
        discussion_id: "d1",
        created_at: "2026-11-02T10:00:00Z",
      },
      merge_request: { iid: 7 },
    };
    await keepGitlabFindingThread(
      db,
      repo,
      "https://github.com",
      reply,
      undefined,
      new Date(),
      (n, note) => {
        asked.push(`${n}/${note}`);
        return Promise.resolve({ up: 2, down: 1 });
      },
    );
    expect(asked).toEqual(["7/100"]);
    expect(await finding()).toMatchObject({ thumbsUp: 2, thumbsDown: 1 });
  });

  it("counts GitLab's thumbsup and thumbsdown awards of a note", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      urls.push(url);
      return Response.json([
        { name: "thumbsup" },
        { name: "thumbsup" },
        { name: "thumbsdown" },
        { name: "tada" },
      ]);
    });
    const read = await gitlab?.reactions.read("t", "group/app", 3, ["55", "not-a-note"]);
    expect(read instanceof Map ? Object.fromEntries(read) : read).toEqual({
      "55": { up: 2, down: 1 },
    });
    expect(urls).toEqual([
      `${GITLAB}/api/v4/projects/group%2Fapp/merge_requests/3/notes/55/award_emoji?per_page=100`,
    ]);
  });

  it("reads the threads of open pull requests in the reconciliation, within its budget", async () => {
    await signIn(42, "octo");
    const { data, finding } = await onRecord();
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      reads++;
      return Response.json([{ id: 100, reactions: { "+1": 4, "-1": 0 } }]);
    });
    if (!github) throw new Error("no GitHub");
    const now = new Date();
    const run = (open: number[], calls: CallBudget) =>
      reconcileReactions({
        data,
        platform: github,
        token: "t",
        fullName: "octo/api",
        open,
        calls,
        now,
      });
    expect(await run([7], new CallBudget(0))).toBe("spent");
    expect(await run([8], new CallBudget(5))).toBe(0);
    expect(reads).toBe(0);
    expect(await run([7], new CallBudget(5))).toBe(1);
    expect(await finding()).toMatchObject({ thumbsUp: 4, thumbsDown: 0 });
    // Read today: the next run leaves it.
    expect(await run([7], new CallBudget(5))).toBe(0);
    expect(reads).toBe(1);
  });

  it("reads the threads of a pull request merged lately, not of one merged long ago", async () => {
    await signIn(42, "octo");
    const { data, reviewRepoId, finding } = await onRecord();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json([{ id: 100, reactions: { "+1": 0, "-1": 3 } }]),
    );
    if (!github) throw new Error("no GitHub");
    const now = new Date();
    const merged = (days: number) =>
      data.closedPulls.record({
        reviewRepoId,
        number: 7,
        title: "T",
        merged: true,
        openedAt: null,
        closedAt: new Date(now.getTime() - days * 24 * 60 * 60_000),
      });
    const run = () =>
      reconcileReactions({
        data,
        platform: github,
        token: "t",
        fullName: "octo/api",
        open: [],
        calls: new CallBudget(5),
        now,
      });
    await merged(30);
    expect(await run()).toBe(0);
    await merged(2);
    expect(await run()).toBe(1);
    expect(await finding()).toMatchObject({ thumbsUp: 0, thumbsDown: 3 });
  });
});

describe("finding insights with reactions", () => {
  it("counts accepted as fixed or 👍 once a finding, apart from addressed, with 👍 and 👎 rates", async () => {
    const me = await signIn(42, "octo");
    const data = scoped(db, me.account.id);
    const one = await seed("https://github.com/octo/api", 7, { fingerprint: "a".repeat(16) }, "r1");
    await seed("https://github.com/octo/api", 7, { fingerprint: "b".repeat(16) }, "r2");
    await seed("https://github.com/octo/api", 7, { fingerprint: "c".repeat(16) }, "r3");
    const at = new Date();
    const on = (fingerprint: string) => ({ identity, number: 7, fingerprint });
    // Fixed and 👍: accepted once.
    await data.decide([one.id], { status: "fixed", reason: null, note: null, decidedAt: at });
    await data.findingOutcomes.recordReactions(on("a".repeat(16)), { up: 2, down: 0 }, at);
    // 👎 and its thread resolved: addressed, not accepted.
    await data.findingOutcomes.recordReactions(on("b".repeat(16)), { up: 0, down: 1 }, at);
    await data.findingOutcomes.markThreadResolved(
      { identity, number: 7, fingerprints: ["b".repeat(16)] },
      true,
      at,
    );
    // 👍 alone: accepted.
    await data.findingOutcomes.recordReactions(on("c".repeat(16)), { up: 1, down: 1 }, at);

    const res = await call("/api/findings/insights", { auth: me.auth });
    const got = (await res.json()) as FindingInsightsView;
    expect(got.total).toMatchObject({
      total: 3,
      fixed: 1,
      addressed: 1,
      accepted: 2,
      thumbsUp: 2,
      thumbsDown: 2,
      reacted: 3,
      thumbsUpRate: 2 / 3,
      downvoteRate: 2 / 3,
    });
    const [reviewer] = got.byReviewer;
    expect(reviewer).toMatchObject({ accepted: 2, thumbsUpRate: 2 / 3, downvoteRate: 2 / 3 });
    expect(got.byCategory[0]).toMatchObject({ accepted: 2, reacted: 3 });
  });
});

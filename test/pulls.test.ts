import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { PullItem } from "../src/shared/index.js";
import { db, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

type Listed = {
  platforms: {
    platform: string;
    linked: boolean;
    failed: boolean;
    more: boolean;
    pulls: PullItem[];
  }[];
};

const node = (n: number, over: Record<string, unknown> = {}) => ({
  id: `PR_${n}`,
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: `2026-11-2${n}T10:00:00Z`,
  additions: 10,
  deletions: 2,
  reviewDecision: "REVIEW_REQUIRED",
  author: { login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
  repository: { nameWithOwner: "octo/api" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...over,
});

type Asked = { query: string; variables: Record<string, unknown> };
const graphql = (answer: (q: string, asked: Asked) => unknown) => async (req: Request) => {
  if (req.url !== "https://api.github.com/graphql") return undefined;
  if (req.headers.get("authorization") !== "Bearer ghu_first") {
    return new Response(null, { status: 401 });
  }
  const asked = (await req.json()) as Asked;
  return Response.json(answer(asked.query, asked));
};

describe("the pull request inbox", () => {
  it("lists the GitHub pulls asking my review, mine and my week's merges, once each, newest first", async () => {
    const asked: Asked[] = [];
    githubFake({
      extra: graphql((_q, a) => {
        asked.push(a);
        return {
          data: {
            review: { issueCount: 2, nodes: [node(1), node(3, { isDraft: true })] },
            authored: {
              issueCount: 1,
              nodes: [node(3, { isDraft: true, author: { login: "octo" } })],
            },
            merged: {
              issueCount: 1,
              nodes: [
                node(2, {
                  state: "MERGED",
                  mergedAt: "2026-11-22T09:00:00Z",
                  author: { login: "eve", avatarUrl: "https://elsewhere.example/eve.png" },
                }),
              ],
            },
          },
        };
      }),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/platforms/pulls");
    // How long the platform listing took, apart from the rest: the inbox's slowest read.
    expect(res.headers.get("server-timing")).toMatch(/\blist;dur=[\d.]+.*\bmarks;dur=/);
    const listed = (await res.json()) as Listed;
    const gh = listed.platforms.find((p) => p.platform === "github");
    expect(gh).toMatchObject({ linked: true, failed: false, more: false });
    expect(gh?.pulls.map((p) => [p.number, p.roles])).toEqual([
      [3, ["reviewer", "author"]],
      [2, ["author"]],
      [1, ["reviewer"]],
    ]);
    expect(gh?.pulls[1]).toMatchObject({ state: "merged", mergedAt: "2026-11-22T09:00:00Z" });
    // A picture is passed on only from the host the console's content policy loads.
    expect(gh?.pulls[1]?.authorAvatar).toBeNull();
    expect(gh?.pulls[2]?.authorAvatar).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(gh?.pulls[2]).toMatchObject({
      repo: "octo/api",
      checks: "failing",
      review: "required",
      draft: false,
      additions: 10,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.variables.merged).toMatch(
      /^is:pr is:merged author:@me merged:>=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("asks again without checks when the App may not read them, rather than lose the pulls", async () => {
    const asked: boolean[] = [];
    githubFake({
      extra: graphql((q) => {
        const checks = q.includes("statusCheckRollup");
        asked.push(checks);
        const pulls = checks ? [null] : [node(1, { commits: undefined })];
        return {
          data: {
            review: { issueCount: 1, nodes: pulls },
            authored: { issueCount: 0, nodes: [] },
            merged: { issueCount: 0, nodes: [] },
          },
          ...(checks ? { errors: [{ message: "Resource not accessible by integration" }] } : {}),
        };
      }),
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    expect(asked).toEqual([true, false]);
    expect(listed.platforms[0]?.pulls.map((p) => [p.number, p.checks])).toEqual([[1, null]]);
  });

  it("says when GitHub refused, and more when a section holds more than it read", async () => {
    githubFake({
      extra: graphql(() => ({
        data: {
          review: { issueCount: 120, nodes: [node(1)] },
          authored: { issueCount: 0, nodes: [] },
          merged: { issueCount: 0, nodes: [] },
        },
      })),
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    expect(listed.platforms[0]?.more).toBe(true);

    vi.restoreAllMocks();
    githubFake({ extra: graphql(() => ({ errors: [{ message: "Bad credentials" }] })) });
    const refused = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    expect(refused.platforms[0]).toMatchObject({ linked: true, failed: true, pulls: [] });
  });

  it("lists GitLab merge requests I review and opened, with their project's path", async () => {
    const mr = (id: number, iid: number, author: string) => ({
      id,
      iid,
      title: `MR ${iid}`,
      web_url: `${GITLAB}/Group/Sub/Project/-/merge_requests/${iid}`,
      draft: iid === 5,
      created_at: "2026-11-19T08:00:00Z",
      updated_at: `2026-11-1${iid}T08:00:00Z`,
      author: { username: author },
      sha: String(iid).repeat(40),
      references: { full: `Group/Sub/Project!${iid}` },
    });
    githubFake({
      extra: (req) => {
        if (req.url.startsWith("https://api.github.com/graphql")) {
          return Response.json({
            data: {
              review: { issueCount: 0, nodes: [] },
              authored: { issueCount: 0, nodes: [] },
              merged: { issueCount: 0, nodes: [] },
            },
          });
        }
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (req.headers.get("authorization") !== "Bearer glpat_first") {
          return new Response(null, { status: 401 });
        }
        if (req.url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        const q = new URL(req.url).searchParams;
        if (q.get("reviewer_id") === "77")
          return Response.json([mr(101, 4, "ada"), mr(102, 5, "me")]);
        if (q.get("state") === "merged") {
          expect(q.get("updated_after")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          return Response.json([{ ...mr(103, 6, "me"), state: "merged" }]);
        }
        if (q.get("scope") === "created_by_me") return Response.json([mr(102, 5, "me")]);
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const lab = listed.platforms.find((p) => p.platform === "gitlab");
    expect(lab).toMatchObject({ linked: true, failed: false });
    expect(lab?.pulls.find((p) => p.number === 6)?.state).toBe("merged");
    expect(lab?.pulls.find((p) => p.number === 4)).toMatchObject({
      head: "4".repeat(40),
      unread: false,
    });
    expect(lab?.pulls.map((p) => [p.number, p.repo, p.draft, p.roles])).toEqual([
      [6, "Group/Sub/Project", false, ["author"]],
      [5, "Group/Sub/Project", true, ["reviewer", "author"]],
      [4, "Group/Sub/Project", false, ["reviewer"]],
    ]);
  });

  it("places GitHub pulls stacked in one repository, leaving forks, merges and loners out", async () => {
    const branch = (n: number, head: string, base: string, over: Record<string, unknown> = {}) =>
      node(n, { headRefName: head, baseRefName: base, isCrossRepository: false, ...over });
    githubFake({
      extra: graphql(() => ({
        data: {
          review: {
            issueCount: 3,
            nodes: [
              branch(1, "a", "main"),
              branch(5, "c", "b"),
              branch(6, "x", "a", { isCrossRepository: true }),
            ],
          },
          authored: { issueCount: 2, nodes: [branch(3, "b", "a"), branch(4, "solo", "main")] },
          merged: {
            issueCount: 1,
            nodes: [branch(2, "c", "b", { state: "MERGED", mergedAt: "2026-11-22T09:00:00Z" })],
          },
        },
      })),
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const pulls = listed.platforms[0]?.pulls ?? [];
    expect(Object.fromEntries(pulls.map((p) => [p.number, p.stack ?? null]))).toEqual({
      1: { id: "octo/api#1", position: 1, size: 3 },
      3: { id: "octo/api#1", position: 2, size: 3 },
      5: { id: "octo/api#1", position: 3, size: 3 },
      2: null,
      4: null,
      6: null,
    });
    expect(pulls[0]).not.toHaveProperty("branches");
  });

  it("places GitLab merge requests stacked in one project, not one from a fork", async () => {
    const mr = (iid: number, source: string, target: string, fork = false) => ({
      id: 200 + iid,
      iid,
      title: `MR ${iid}`,
      web_url: `${GITLAB}/Group/Project/-/merge_requests/${iid}`,
      state: "opened",
      created_at: "2026-11-19T08:00:00Z",
      updated_at: `2026-11-1${iid}T08:00:00Z`,
      author: { username: "me" },
      references: { full: `Group/Project!${iid}` },
      source_branch: source,
      target_branch: target,
      source_project_id: fork ? 9 : 1,
      target_project_id: 1,
    });
    githubFake({
      extra: (req) => {
        if (req.url.startsWith("https://api.github.com/graphql")) {
          return Response.json({
            data: {
              review: { issueCount: 0, nodes: [] },
              authored: { issueCount: 0, nodes: [] },
              merged: { issueCount: 0, nodes: [] },
            },
          });
        }
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (req.url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        const q = new URL(req.url).searchParams;
        if (q.get("reviewer_id") === "77")
          return Response.json([mr(3, "b", "a"), mr(4, "z", "b", true)]);
        if (q.get("state") === "merged") return Response.json([]);
        if (q.get("scope") === "created_by_me") return Response.json([mr(2, "a", "main")]);
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const lab = listed.platforms.find((p) => p.platform === "gitlab");
    expect(lab?.pulls.map((p) => [p.number, p.stack ?? null])).toEqual([
      [4, null],
      [3, { id: "Group/Project#2", position: 2, size: 2 }],
      [2, { id: "Group/Project#2", position: 1, size: 2 }],
    ]);
  });

  /** GitLab listing MR 1 for my review and my MR 5, every MR read on its own (4 merged); the group 55 with me on it asked of `asked`. */
  async function groupAsked(asked: number[]) {
    const mr = (iid: number, state = "opened", author = "ada") => ({
      id: 300 + iid,
      iid,
      title: `MR ${iid}`,
      web_url: `${GITLAB}/acme/api/-/merge_requests/${iid}`,
      state,
      created_at: "2026-11-19T08:00:00Z",
      updated_at: new Date(Date.UTC(2026, 10, 1, iid)).toISOString(),
      author: { username: author },
      references: { full: `acme/api!${iid}` },
    });
    const read: number[] = [];
    githubFake({
      extra: (req) => {
        if (req.url.startsWith("https://api.github.com/graphql")) {
          return Response.json({
            data: {
              review: { issueCount: 0, nodes: [] },
              authored: { issueCount: 0, nodes: [] },
              merged: { issueCount: 0, nodes: [] },
            },
          });
        }
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/api/v4/user") return Response.json({ id: 77 });
        const one = /^\/api\/v4\/projects\/acme%2Fapi\/merge_requests\/(\d+)$/.exec(url.pathname);
        if (one) {
          const iid = Number(one[1]);
          read.push(iid);
          return Response.json(mr(iid, iid === 4 ? "merged" : "opened"));
        }
        const q = url.searchParams;
        if (q.get("reviewer_id") === "77") return Response.json([mr(1)]);
        if (q.get("state") === "merged") return Response.json([]);
        if (q.get("scope") === "created_by_me") return Response.json([mr(5, "opened", "me")]);
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const [account] = await db.select().from(schema.accounts);
    const data = scoped(db, account?.id ?? "");
    const host = new URL(GITLAB).host;
    const repo = await data.insert("reviewRepos", {
      platform: "gitlab",
      host,
      platformRepoId: "9",
      fullName: "acme/api",
    });
    const at = new Date(Date.now() - 60 * 60_000);
    await data.reviewTeams.keep({
      platform: "gitlab",
      host,
      reviewerId: "team:55",
      name: "acme/backend",
      members: ["77", "8"],
      at,
    });
    for (const number of asked) {
      await data.reviewRequests.asked({
        reviewRepoId: repo,
        number,
        reviewerId: "team:55",
        at: new Date(at.getTime() + number * 1000),
      });
    }
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    return { lab: listed.platforms.find((p) => p.platform === "gitlab"), read };
  }

  it("lists GitLab merge requests asked of a group I am on, once each, with the group", async () => {
    // 1 lists me as a reviewer already, 4 is merged, 5 is mine, 6 only my group's.
    const { lab, read } = await groupAsked([1, 4, 5, 6]);
    expect(lab?.pulls.map((p) => [p.number, p.roles, p.requestedTeam ?? null])).toEqual([
      [6, ["reviewer"], "acme/backend"],
      [5, ["author"], null],
      [1, ["reviewer"], "acme/backend"],
    ]);
    expect(read.sort()).toEqual([4, 6]);
    expect(lab?.more).toBe(false);
  });

  it("reads ten merge requests asked of my groups at most, the newest asks, and says more wait", async () => {
    const { lab, read } = await groupAsked([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(read.sort((x, y) => x - y)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(lab?.pulls.filter((p) => p.requestedTeam)).toHaveLength(10);
    expect(lab?.more).toBe(true);
  });

  it("asks a sign-in first", async () => {
    const { call } = await import("./helpers.js");
    expect((await call("/api/platforms/pulls")).status).toBe(401);
  });
});

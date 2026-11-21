import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullItem } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
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
  author: { login: "ada" },
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
              nodes: [node(2, { state: "MERGED", mergedAt: "2026-11-22T09:00:00Z" })],
            },
          },
        };
      }),
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const gh = listed.platforms.find((p) => p.platform === "github");
    expect(gh).toMatchObject({ linked: true, failed: false, more: false });
    expect(gh?.pulls.map((p) => [p.number, p.roles])).toEqual([
      [3, ["reviewer", "author"]],
      [2, ["author"]],
      [1, ["reviewer"]],
    ]);
    expect(gh?.pulls[1]).toMatchObject({ state: "merged", mergedAt: "2026-11-22T09:00:00Z" });
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
    expect(lab?.pulls.map((p) => [p.number, p.repo, p.draft, p.roles])).toEqual([
      [6, "Group/Sub/Project", false, ["author"]],
      [5, "Group/Sub/Project", true, ["reviewer", "author"]],
      [4, "Group/Sub/Project", false, ["reviewer"]],
    ]);
  });

  it("asks a sign-in first", async () => {
    const { call } = await import("./helpers.js");
    expect((await call("/api/platforms/pulls")).status).toBe(401);
  });
});

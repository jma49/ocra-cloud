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

const graphql = (answer: (q: string) => unknown) => async (req: Request) => {
  if (req.url !== "https://api.github.com/graphql") return undefined;
  if (req.headers.get("authorization") !== "Bearer ghu_first") {
    return new Response(null, { status: 401 });
  }
  const { query } = (await req.json()) as { query: string };
  return Response.json(answer(query));
};

describe("the pull request inbox", () => {
  it("lists the GitHub pulls asking my review and mine, once each, newest change first", async () => {
    const asked: string[] = [];
    githubFake({
      extra: graphql((q) => {
        asked.push(q);
        return {
          data: {
            review: { issueCount: 2, nodes: [node(1), node(3, { isDraft: true })] },
            authored: {
              issueCount: 1,
              nodes: [node(3, { isDraft: true, author: { login: "octo" } })],
            },
          },
        };
      }),
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const gh = listed.platforms.find((p) => p.platform === "github");
    expect(gh).toMatchObject({ linked: true, failed: false, more: false });
    expect(gh?.pulls.map((p) => [p.number, p.sections])).toEqual([
      [3, ["review", "authored"]],
      [1, ["review"]],
    ]);
    expect(gh?.pulls[1]).toMatchObject({
      repo: "octo/api",
      checks: "failing",
      review: "required",
      draft: false,
      additions: 10,
    });
    expect(asked).toHaveLength(1);
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
            data: { review: { issueCount: 0, nodes: [] }, authored: { issueCount: 0, nodes: [] } },
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
        if (q.get("scope") === "created_by_me") return Response.json([mr(102, 5, "me")]);
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const lab = listed.platforms.find((p) => p.platform === "gitlab");
    expect(lab).toMatchObject({ linked: true, failed: false });
    expect(lab?.pulls.map((p) => [p.number, p.repo, p.draft, p.sections])).toEqual([
      [5, "Group/Sub/Project", true, ["review", "authored"]],
      [4, "Group/Sub/Project", false, ["review"]],
    ]);
  });

  it("asks a sign-in first", async () => {
    const { call } = await import("./helpers.js");
    expect((await call("/api/platforms/pulls")).status).toBe(401);
  });
});

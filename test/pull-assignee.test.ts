import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPullFilters, type PullItem } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

type Listed = { platforms: { platform: string; more: boolean; pulls: PullItem[] }[] };

const EMPTY = { issueCount: 0, nodes: [] };

const node = (n: number, author = "ada") => ({
  id: `PR_${n}`,
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: `2026-11-2${n}T10:00:00Z`,
  additions: 1,
  deletions: 1,
  reviewDecision: null,
  author: { login: author },
  repository: { nameWithOwner: "octo/api" },
});

const mr = (iid: number, author = "ada") => ({
  id: 400 + iid,
  iid,
  title: `MR ${iid}`,
  web_url: `${GITLAB}/acme/api/-/merge_requests/${iid}`,
  state: "opened",
  created_at: "2026-11-19T08:00:00Z",
  updated_at: `2026-11-1${iid}T08:00:00Z`,
  author: { username: author },
  references: { full: `acme/api!${iid}` },
});

describe("pull requests assigned to the user", () => {
  it("lists GitHub pulls assigned to me in the one search request, keeping a stronger role", async () => {
    const asked: Record<string, unknown>[] = [];
    githubFake({
      extra: async (req) => {
        if (req.url !== "https://api.github.com/graphql") return undefined;
        const body = (await req.json()) as { variables: Record<string, unknown> };
        asked.push(body.variables);
        return Response.json({
          data: {
            review: { issueCount: 1, nodes: [node(1)] },
            authored: { issueCount: 1, nodes: [node(2, "octo")] },
            assigned: { issueCount: 60, nodes: [node(1), node(2, "octo"), node(4)] },
            merged: EMPTY,
          },
        });
      },
    });
    const a = await signInWithGithub();
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const gh = listed.platforms.find((p) => p.platform === "github");
    expect(gh?.pulls.map((p) => [p.number, p.roles])).toEqual([
      [4, ["assignee"]],
      [2, ["author"]],
      [1, ["reviewer"]],
    ]);
    expect(gh?.more).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.assigned).toBe("is:pr is:open archived:false assignee:@me");
  });

  it("lists open GitLab merge requests assigned to me across projects", async () => {
    const assignedAsks: URLSearchParams[] = [];
    githubFake({
      extra: (req) => {
        if (req.url.startsWith("https://api.github.com/graphql")) {
          return Response.json({
            data: { review: EMPTY, authored: EMPTY, assigned: EMPTY, merged: EMPTY },
          });
        }
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/api/v4/user") return Response.json({ id: 77 });
        const q = url.searchParams;
        if (q.get("reviewer_id") === "77") return Response.json([mr(1)]);
        if (q.get("state") === "merged") return Response.json([]);
        if (q.get("assignee_id") === "77") {
          assignedAsks.push(q);
          return Response.json([mr(1), mr(5, "me"), mr(6)]);
        }
        if (q.get("scope") === "created_by_me") return Response.json([mr(5, "me")]);
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
    const lab = listed.platforms.find((p) => p.platform === "gitlab");
    expect(lab?.pulls.map((p) => [p.number, p.roles])).toEqual([
      [6, ["assignee"]],
      [5, ["author"]],
      [1, ["reviewer"]],
    ]);
    expect(assignedAsks.map((q) => [q.get("scope"), q.get("state")])).toEqual([["all", "opened"]]);
    // Three assigned of a page of 50 leave none unlisted.
    expect(lab?.more).toBe(false);
    expect(assignedAsks[0]?.get("per_page")).toBe("50");
  });

  it("filters a view by the assignee role, and the views route keeps it", async () => {
    const pull = {
      roles: ["assignee"],
      draft: false,
      state: "open",
      host: "github.com",
    } as Parameters<typeof matchesPullFilters>[0];
    expect(matchesPullFilters(pull, { roles: ["assignee"] }, Date.now())).toBe(true);
    expect(matchesPullFilters(pull, { roles: ["reviewer", "author"] }, Date.now())).toBe(false);

    githubFake({});
    const a = await signInWithGithub();
    const res = await a.send("/api/pull-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Assigned", filters: { roles: ["assignee"] } }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { filters: unknown }).filters).toEqual({ roles: ["assignee"] });
  });
});

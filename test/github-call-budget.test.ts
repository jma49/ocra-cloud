import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// What one load of the inbox and of a pull request's page costs of the
// user's hourly GitHub allowance: every REST or GraphQL call GitHub answers
// with anything but 304 counts (a conditional request answered 304 does
// not). Loaded again with nothing changed, the page's REST calls are all
// conditional, and the branch rule's refusal is not asked again.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com";
const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const REPO = `${API}/repos/octo/api`;
const REF = "platform=github&repo=octo/api&number=7";
/** The calls the pull request's page makes as it opens (web/src/pages/PullPage.tsx). */
const PAGE = ["files", "readiness", "reviewers", "stack", "threads", "queue"].map(
  (p) => `/api/pulls/${p}?${REF}`,
);

const REST: Record<string, { status: number; body: unknown }> = {
  [REPO]: {
    status: 200,
    body: {
      id: 1,
      full_name: "octo/api",
      default_branch: "main",
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: false,
    },
  },
  [`${REPO}/pulls/7`]: {
    status: 200,
    body: {
      title: "fix: cap refunds",
      user: { login: "dev", type: "User" },
      html_url: "https://github.com/octo/api/pull/7",
      state: "open",
      merged: false,
      base: { sha: BASE, repo: { id: 1 } },
      head: { sha: HEAD },
      changed_files: 1,
      updated_at: "2026-11-22T10:00:00Z",
      requested_reviewers: [],
    },
  },
  [`${REPO}/pulls/7/files?per_page=100&page=1`]: {
    status: 200,
    body: [
      {
        filename: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-a\n+b",
        sha: "e".repeat(40),
      },
    ],
  },
  [`${REPO}/branches/main/protection`]: {
    status: 403,
    body: { message: "Resource not accessible by integration" },
  },
  [`${REPO}/branches/main`]: {
    status: 200,
    body: { name: "main", protected: false },
  },
  [`${REPO}/rules/branches/main?per_page=100`]: { status: 200, body: [] },
};

function readinessAnswer() {
  return {
    data: {
      repository: {
        databaseId: 1,
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          reviewDecision: null,
          title: "fix: cap refunds",
          body: "",
          headRefOid: HEAD,
          baseRefName: "main",
          changedFiles: 1,
          additions: 1,
          deletions: 1,
          baseRef: { branchProtectionRule: null, target: { c0: null, c1: null, c2: null } },
          reviews: { nodes: [] },
          teams: { nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "src/app.ts" }] },
          commits: { nodes: [] },
        },
      },
    },
  };
}

const EMPTY_SEARCH = { issueCount: 0, nodes: [] };

type Tally = { rest: number; graphql: number; notModified: number };

/** A GitHub that answers ETags and conditional requests; `limited` refuses everything as GitHub does once the allowance is used up. */
function counted(opts: { limited?: boolean } = {}) {
  const tally: Tally = { rest: 0, graphql: 0, notModified: 0 };
  githubFake({
    extra: async (req) => {
      const url = req.url;
      if (!url.startsWith(`${API}/`) || url.includes("/installations") || url === `${API}/user`) {
        return undefined;
      }
      if (opts.limited) {
        if (url.endsWith("/graphql")) tally.graphql++;
        else tally.rest++;
        return Response.json(
          { message: "API rate limit exceeded for user ID 42." },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" },
          },
        );
      }
      if (req.method === "POST" && url === `${API}/graphql`) {
        tally.graphql++;
        const { query } = (await req.json()) as { query: string };
        if (query.includes("latestOpinionatedReviews")) return Response.json(readinessAnswer());
        if (query.includes("authored: search")) {
          return Response.json({
            data: {
              review: EMPTY_SEARCH,
              authored: EMPTY_SEARCH,
              assigned: EMPTY_SEARCH,
              merged: EMPTY_SEARCH,
            },
          });
        }
        return Response.json({ data: null });
      }
      const answer = REST[url];
      if (req.method !== "GET" || !answer) return undefined;
      const etag = `"${url.length}-${answer.status}"`;
      if (answer.status === 200 && req.headers.get("if-none-match") === etag) {
        tally.notModified++;
        return new Response(null, { status: 304, headers: { etag } });
      }
      tally.rest++;
      return Response.json(answer.body, {
        status: answer.status,
        headers: answer.status === 200 ? { etag } : {},
      });
    },
  });
  return tally;
}

async function load(send: (p: string) => Promise<Response>, paths: readonly string[]) {
  for (const p of paths) await (await send(p)).arrayBuffer();
}

describe("GitHub calls per load", () => {
  it("opens a pull request's page for 6 counted REST calls, then again for none", async () => {
    const tally = counted();
    const a = await signInWithGithub();
    await load(a.send, PAGE);
    // The rest repeat an answer the same load already read: 304s.
    expect(tally).toMatchObject({ rest: 6, graphql: 6 });

    const again = counted();
    await load(a.send, PAGE);
    // Every answer with an ETag comes back 304; the refused branch rule is not asked.
    expect(again).toEqual({ rest: 0, graphql: 6, notModified: 8 });
  });

  it("asks one GraphQL query per inbox list, sent together, and no REST call", async () => {
    const tally = counted();
    const a = await signInWithGithub();
    await load(a.send, ["/api/platforms/pulls", "/api/platforms/pulls?group=views"]);
    expect(tally).toEqual({ rest: 0, graphql: 8, notModified: 0 });
  });
});

describe("a used-up GitHub allowance", () => {
  it("answers the pull request's page with when it is back, not with not_found", async () => {
    counted({ limited: true });
    const a = await signInWithGithub();
    const res = await a.send(`/api/pulls/files?${REF}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "upstream_unreachable",
      reason: "platform_rate_limited",
      retryAt: new Date(1_795_000_000_000).toISOString(),
    });
  });

  it("answers the inbox with it rather than an empty list", async () => {
    counted({ limited: true });
    const a = await signInWithGithub();
    const res = await a.send("/api/platforms/pulls");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "platform_rate_limited" });
  });

  it("is not remembered as a refusal of the branch rule", async () => {
    counted({ limited: true });
    const a = await signInWithGithub();
    await (await a.send(`/api/pulls/readiness?${REF}`)).arrayBuffer();
    const tally = counted();
    const res = await a.send(`/api/pulls/readiness?${REF}`);
    expect(res.status).toBe(200);
    expect(tally.rest).toBe(3);
  });
});

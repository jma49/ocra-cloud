import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import {
  normaliseSearchQuery,
  pullReferenceOf,
  type SearchResultsView,
} from "../src/shared/index.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const node = (n: number, repo = "octo/api") => ({
  id: `PR_${n}`,
  number: n,
  title: `Fix refund rounding ${n}`,
  url: `https://github.com/${repo}/pull/${n}`,
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-21T10:00:00Z",
  additions: 3,
  deletions: 1,
  reviewDecision: null,
  author: { login: "ada" },
  repository: { nameWithOwner: repo },
});

const mr = (iid: number) => ({
  id: 500 + iid,
  iid,
  title: `Refund MR ${iid}`,
  web_url: `${GITLAB}/Group/Project/-/merge_requests/${iid}`,
  state: "opened",
  created_at: "2026-11-19T08:00:00Z",
  updated_at: "2026-11-20T08:00:00Z",
  author: { username: "ada" },
  references: { full: `Group/Project!${iid}` },
});

type Asked = { query: string; variables: Record<string, unknown> };

/** GitHub's GraphQL answering `answer`, recording what was asked. */
function github(answer: (a: Asked) => Response | unknown, asked: Asked[] = []) {
  return async (req: Request) => {
    if (req.url !== "https://api.github.com/graphql") return undefined;
    const a = (await req.json()) as Asked;
    asked.push(a);
    const out = answer(a);
    return out instanceof Response ? out : Response.json(out);
  };
}

const search = async (send: (p: string) => Promise<Response>, q: string, limit = "") => {
  const res = await send(`/api/search?q=${encodeURIComponent(q)}${limit && `&limit=${limit}`}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResultsView;
};

async function accountOf(login: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.login, login));
  if (!row) throw new Error("no account");
  return row.id;
}

/** A pull request review of octo/api #12 with one finding, and an enrolled repository. */
async function seed(accountId: string, title: string) {
  const d = scoped(db, accountId);
  const reviewId = `review-${accountId}`;
  await d.insert("reviews", {
    id: reviewId,
    runId: `run-${accountId}`,
    repoHash: `hash-${accountId}`,
    source: "github",
    prRepository: "https://github.com/octo/api",
    prNumber: 12,
    findings: 1,
  });
  await d.insert("findings", {
    reviewId,
    fingerprint: `fp-${accountId}`,
    reviewer: "correctness",
    severity: "warning",
    file: "src/refund.ts",
    lineStart: 7,
    title,
    body: "b",
  });
  await d.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: `id-${accountId}`,
    fullName: `octo/api-${accountId}`,
  });
  return reviewId;
}

describe("the query", () => {
  it("is trimmed, its spaces collapsed, its control characters dropped and capped at 100", () => {
    expect(normaliseSearchQuery("  fix \t\n refund\u0000 ")).toBe("fix refund");
    expect([...normaliseSearchQuery("é".repeat(150))]).toHaveLength(100);
  });

  it("reads #123, owner/repo#123 and group/sub/project!123 as references, nothing else", () => {
    expect(pullReferenceOf("#123")).toEqual({ repo: null, number: 123 });
    expect(pullReferenceOf("octo/api#12")).toEqual({ repo: "octo/api", number: 12 });
    expect(pullReferenceOf("g/s/p!4")).toEqual({ repo: "g/s/p", number: 4 });
    for (const q of ["123", "#0", "api#12", "#12 x", "octo/api#"]) {
      expect(pullReferenceOf(q)).toBeNull();
    }
  });
});

describe("the console's search", () => {
  it("finds my pull requests on every platform, my reviews, shared findings and repositories", async () => {
    const asked: Asked[] = [];
    githubFake({
      extra: async (req) => {
        const hub = await github(() => ({ data: { search: { nodes: [node(12)] } } }), asked)(req);
        if (hub) return hub;
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (req.url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        const q = new URL(req.url).searchParams;
        expect(q.get("search")).toBe("refund");
        return Response.json(q.get("scope") === "created_by_me" ? [mr(3)] : []);
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    await a.send("/api/account/sharing", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const me = await accountOf("octo");
    const reviewId = await seed(me, "Refund rounds down");
    const other = await signIn(9, "eve");
    await seed(other.account.id, "Refund leaks another account");

    const found = await search(a.send, "  refund ");
    expect(found.query).toBe("refund");
    expect(asked[0]?.variables.q).toBe("is:pr involves:@me archived:false refund");
    expect(found.pulls.map((p) => [p.platform, p.error, p.results.map((r) => r.to)])).toEqual([
      ["github", null, ["/pull/github/octo%2Fapi/12"]],
      ["gitlab", null, ["/pull/gitlab/Group%2FProject/3"]],
    ]);
    expect(found.findings).toEqual([
      expect.objectContaining({ reviewId, title: "Refund rounds down", file: "src/refund.ts" }),
    ]);
    expect(found.jump).toBeNull();

    const byRepo = await search(a.send, "octo/api");
    expect(byRepo.reviews.map((r) => [r.id, r.repo, r.prNumber])).toEqual([
      [reviewId, "octo/api", 12],
    ]);
    expect(byRepo.repositories).toEqual([
      expect.objectContaining({ fullName: `octo/api-${me}`, autoReview: true }),
    ]);
    expect(JSON.stringify([found, byRepo])).not.toContain(other.account.id);
    expect(JSON.stringify([found, byRepo])).not.toContain("another account");
  });

  it("neither searches nor answers findings while the account does not share them", async () => {
    githubFake({ extra: github(() => ({ data: { search: { nodes: [] } } })) });
    const a = await signInWithGithub();
    await seed(await accountOf("octo"), "Refund rounds down");
    const found = await search(a.send, "refund");
    expect(found.findings).toBeNull();
    expect(JSON.stringify(found)).not.toContain("rounds down");
    expect(JSON.stringify(found)).not.toContain("src/refund.ts");
  });

  it("marks a platform that fails and still answers the others and the account's rows", async () => {
    githubFake({
      extra: async (req) => {
        if (req.url === "https://api.github.com/graphql")
          return new Response(null, { status: 502 });
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (req.url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        return Response.json([mr(3)]);
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const reviewId = await seed(await accountOf("octo"), "x");
    const found = await search(a.send, "api");
    expect(found.pulls.map((p) => [p.platform, p.linked, p.error, p.results.length])).toEqual([
      ["github", true, "unavailable", 0],
      ["gitlab", true, null, 1],
    ]);
    expect(found.reviews.map((r) => r.id)).toEqual([reviewId]);
  });

  it("jumps straight to the pull request a reference names", async () => {
    const asked: Asked[] = [];
    githubFake({
      extra: github(
        (q) => ({
          data: { repository: { pullRequest: q.variables.number === 12 ? node(12) : null } },
        }),
        asked,
      ),
    });
    const a = await signInWithGithub();
    const reviewId = await seed(await accountOf("octo"), "x");
    const found = await search(a.send, "octo/api#12");
    expect(asked[0]?.variables).toEqual({ owner: "octo", name: "api", number: 12 });
    expect(found.jump?.to).toBe("/pull/github/octo%2Fapi/12");
    expect(found.reviews.map((r) => r.id)).toEqual([reviewId]);
    expect((await search(a.send, "octo/api#13")).jump).toBeNull();
  });

  it("finds a GitLab merge request by its number among mine", async () => {
    githubFake({
      extra: async (req) => {
        const hub = await github(() => ({ data: { search: { nodes: [node(4), node(40)] } } }))(req);
        if (hub) return hub;
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (req.url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        expect(new URL(req.url).searchParams.get("iids[]")).toBe("4");
        return Response.json([]);
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const found = await search(a.send, "#4");
    expect(found.jump?.number).toBe(4);
    expect(found.jump?.platform).toBe("github");
  });

  it("answers destinations alone for an empty query, and bounds the limit", async () => {
    const fetches = githubFake();
    const a = await signInWithGithub();
    const before = fetches.mock.calls.length;
    const empty = await search(a.send, "   ", "500");
    expect(fetches.mock.calls.length).toBe(before);
    expect(empty.destinations.length).toBeLessThanOrEqual(20);
    expect(empty.pulls).toEqual([]);
    const keys = await search(a.send, "api key", "3");
    expect(keys.destinations.map((d) => d.to)).toContain("/keys");
  });

  it("is for the web session only", async () => {
    expect((await call("/api/search?q=x")).status).toBe(401);
  });
});

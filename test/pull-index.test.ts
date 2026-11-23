import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { PullItem } from "../src/shared/index.js";
import { DAY } from "../src/time.js";
import { db, request, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// The inbox answered from the index of enrolled repositories' pull
// requests: after a live listing that matched it, a load asks GitHub
// nothing, a webhook the index follows shows at once, and one it cannot
// follow (checks, reviews), a pull outside the enrolled repositories, or
// time sends the next load to the platform again.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SECRET = "pull-index-secret";
const HEAD = "a".repeat(40);
type Listed = { platforms: { platform: string; more: boolean; pulls: PullItem[] }[] };

const node = (n: number, over: Record<string, unknown> = {}) => ({
  id: `PR_${n}`,
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: `2026-11-1${n}T10:00:00Z`,
  additions: 10,
  deletions: 2,
  reviewDecision: "REVIEW_REQUIRED",
  headRefOid: HEAD,
  author: { login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/5?v=4" },
  repository: { nameWithOwner: "octo/api" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...over,
});

/** GitHub as the inbox reads it, counting the searches it is asked. */
function github(lists: () => Record<string, unknown[]>) {
  const asked = { searches: 0 };
  githubFake({
    extra: async (req) => {
      if (req.url !== "https://api.github.com/graphql") return undefined;
      asked.searches++;
      const all = lists();
      const data = Object.fromEntries(
        ["review", "authored", "assigned", "merged"].map((l) => [
          l,
          { issueCount: all[l]?.length ?? 0, nodes: all[l] ?? [] },
        ]),
      );
      return Response.json({ data });
    },
  });
  return asked;
}

async function deliver(event: string, payload: unknown) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
  });
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
    }),
    env,
    ctx,
  );
  await res.text();
  await waitOnExecutionContext(ctx);
  expect(res.status).toBeLessThan(300);
}

const hookPull = (n: number, over: Record<string, unknown> = {}) => ({
  node_id: `PR_${n}`,
  number: n,
  title: `Change ${n}`,
  html_url: `https://github.com/octo/api/pull/${n}`,
  state: "open",
  draft: false,
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-21T10:00:00Z",
  user: { id: 5, login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/5?v=4" },
  labels: [],
  requested_reviewers: [{ id: 42, login: "octo" }],
  assignees: [],
  head: { sha: HEAD, ref: "feat", repo: { id: 11 } },
  base: { ref: "main", repo: { id: 11 } },
  additions: 10,
  deletions: 2,
  ...over,
});
const repository = { id: 11, full_name: "octo/api" };
/** How long a matching live listing vouches for the index (src/pull-index/inbox.ts). */
const VERIFIED_FOR_MS = 5 * 60_000;

async function setUp(lists: () => Record<string, unknown[]>) {
  const asked = github(lists);
  const a = await signInWithGithub();
  const [account] = await db.select().from(schema.accounts);
  const data = scoped(db, account?.id ?? "");
  await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
    pullsIndexedAt: new Date(),
  });
  const inbox = async () => {
    const res = await a.send("/api/platforms/pulls");
    expect(res.status).toBe(200);
    const listed = (await res.json()) as Listed & { changedAt: unknown };
    return listed.platforms.find((p) => p.platform === "github")?.pulls ?? [];
  };
  return { asked, inbox, data, accountId: account?.id ?? "" };
}

describe("the inbox from the index", () => {
  it("asks GitHub once, then answers from the index, with what webhooks it follows say", async () => {
    const { asked, inbox } = await setUp(() => ({
      review: [node(1)],
      authored: [node(3, { author: { login: "octo" } })],
    }));
    const first = await inbox();
    expect(asked.searches).toBe(4);
    expect(first.map((p) => [p.number, p.roles])).toEqual([
      [3, ["author"]],
      [1, ["reviewer"]],
    ]);

    // The same inbox, field for field, with no platform call.
    expect(await inbox()).toEqual(first);
    expect(asked.searches).toBe(4);

    // A label is followed: shown at once, still with no call, checks kept from the listing.
    await deliver("pull_request", {
      action: "labeled",
      number: 1,
      pull_request: hookPull(1, { labels: [{ name: "urgent" }] }),
      repository,
    });
    const labeled = await inbox();
    expect(asked.searches).toBe(4);
    expect(labeled.find((p) => p.number === 1)).toMatchObject({
      labels: ["urgent"],
      updatedAt: "2026-11-21T10:00:00Z",
      checks: "failing",
      review: "required",
      roles: ["reviewer"],
    });

    // A delivery older than the row changes nothing.
    await deliver("pull_request", {
      action: "edited",
      number: 1,
      pull_request: hookPull(1, { title: "stale", updated_at: "2026-11-20T09:00:00Z" }),
      repository,
    });
    expect((await inbox()).find((p) => p.number === 1)?.title).toBe("Change 1");

    // The ask taken back takes it off the inbox.
    await deliver("pull_request", {
      action: "review_request_removed",
      number: 1,
      requested_reviewer: { id: 42, login: "octo" },
      pull_request: hookPull(1, { requested_reviewers: [], updated_at: "2026-11-22T10:00:00Z" }),
      repository,
    });
    expect((await inbox()).map((p) => p.number)).toEqual([3]);
    expect(asked.searches).toBe(4);

    // Checks finishing are not the index's: the next load reads GitHub.
    await deliver("check_suite", {
      action: "completed",
      check_suite: { head_sha: HEAD, pull_requests: [{ number: 3 }] },
      repository,
    });
    await inbox();
    expect(asked.searches).toBe(8);
  });

  it("reads GitHub every time while the user has a pull outside the enrolled repositories", async () => {
    const { asked, inbox } = await setUp(() => ({
      review: [node(1), node(2, { repository: { nameWithOwner: "octo/web" } })],
    }));
    await inbox();
    await inbox();
    expect(asked.searches).toBe(8);
  });

  it("reads GitHub every time while one of the user's pulls is in a merge queue", async () => {
    const { asked, inbox } = await setUp(() => ({
      authored: [node(1, { author: { login: "octo" }, mergeQueueEntry: { state: "QUEUED" } })],
    }));
    expect((await inbox())[0]?.queued).toBe("waiting");
    expect((await inbox())[0]?.queued).toBe("waiting");
    expect(asked.searches).toBe(8);
  });

  it("reads GitHub again once the listing that vouched for the index is old", async () => {
    const { asked, inbox, accountId } = await setUp(() => ({ review: [node(1)] }));
    await inbox();
    await inbox();
    expect(asked.searches).toBe(4);
    await db
      .update(schema.platformLinks)
      .set({ pullsVerifiedAt: new Date(Date.now() - VERIFIED_FOR_MS - 1000) })
      .where(eq(schema.platformLinks.accountId, accountId));
    await inbox();
    expect(asked.searches).toBe(8);
  });

  it("reads GitHub while the repository's last full reading is too old", async () => {
    const { asked, inbox, data } = await setUp(() => ({ review: [node(1)] }));
    const [repo] = await data.find("reviewRepos", {});
    await data.update("reviewRepos", repo?.id ?? "", {
      pullsIndexedAt: new Date(Date.now() - 3 * DAY),
    });
    await inbox();
    await inbox();
    expect(asked.searches).toBe(8);
  });

  it("answers GitLab from the index too, merge requests asked of my group included", async () => {
    const mr = (iid: number, author = "ada") => ({
      id: 300 + iid,
      iid,
      title: `MR ${iid}`,
      web_url: `${GITLAB}/acme/api/-/merge_requests/${iid}`,
      state: "opened",
      created_at: "2026-11-19T08:00:00.000Z",
      updated_at: new Date(Date.UTC(2026, 10, 1, iid)).toISOString(),
      author: { username: author },
      references: { full: `acme/api!${iid}` },
    });
    const calls = { gitlab: 0 };
    githubFake({
      extra: (req) => {
        if (req.url.startsWith("https://api.github.com/graphql")) {
          return Response.json({
            data: Object.fromEntries(
              ["review", "authored", "assigned", "merged"].map((l) => [
                l,
                { issueCount: 0, nodes: [] },
              ]),
            ),
          });
        }
        if (!req.url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        const url = new URL(req.url);
        if (url.pathname === "/api/v4/user") return Response.json({ id: 77 });
        calls.gitlab++;
        if (url.pathname.endsWith("/merge_requests/6")) return Response.json(mr(6));
        const q = url.searchParams;
        if (q.get("reviewer_id") === "77") return Response.json([mr(1)]);
        if (q.get("state") === "merged") return Response.json([]);
        if (q.get("assignee_id") === "77") return Response.json([]);
        if (q.get("scope") === "created_by_me") return Response.json([mr(5, "me")]);
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
      pullsIndexedAt: new Date(),
    });
    const at = new Date(Date.now() - 60 * 60_000);
    await data.reviewTeams.keep({
      platform: "gitlab",
      host,
      reviewerId: "team:55",
      name: "acme/backend",
      members: ["77"],
      at,
    });
    await data.reviewRequests.asked({ reviewRepoId: repo, number: 6, reviewerId: "team:55", at });
    const inbox = async () => {
      const listed = (await (await a.send("/api/platforms/pulls")).json()) as Listed;
      return listed.platforms.find((p) => p.platform === "gitlab")?.pulls ?? [];
    };
    const first = await inbox();
    // Three lists of open ones, the week's merges and the one asked of the group.
    expect(calls.gitlab).toBe(5);
    expect(first.map((p) => [p.number, p.roles, p.requestedTeam ?? null])).toEqual([
      [6, ["reviewer"], "acme/backend"],
      [5, ["author"], null],
      [1, ["reviewer"], null],
    ]);
    expect(await inbox()).toEqual(first);
    expect(calls.gitlab).toBe(5);
  });
});

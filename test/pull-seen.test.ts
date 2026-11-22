import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { MAX_SEEN_BULK, type PullItem, pullUnread } from "../src/shared/index.js";
import { db, resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const T0 = "2026-11-20T10:00:00Z";
const T1 = "2026-11-21T10:00:00Z";

type Pull = { updatedAt: string; head: string; state?: string; mergedAt?: string | null };
type Listed = { platforms: { pulls: PullItem[] }[] };

/** GitHub lists one pull request, octo/api #7, as `now` says at each call. */
function listing(now: { pull: Pull }) {
  githubFake({
    extra: (req) =>
      req.url === "https://api.github.com/graphql"
        ? Response.json({
            data: {
              review: {
                issueCount: 1,
                nodes: [
                  {
                    id: "PR_7",
                    number: 7,
                    title: "Change",
                    url: "https://github.com/octo/api/pull/7",
                    isDraft: false,
                    state: now.pull.state ?? "OPEN",
                    createdAt: T0,
                    updatedAt: now.pull.updatedAt,
                    mergedAt: now.pull.mergedAt ?? null,
                    additions: 1,
                    deletions: 1,
                    reviewDecision: null,
                    headRefOid: now.pull.head,
                    author: { login: "ada" },
                    repository: { nameWithOwner: "Octo/API" },
                  },
                ],
              },
              authored: { issueCount: 0, nodes: [] },
              merged: { issueCount: 0, nodes: [] },
            },
          })
        : undefined,
  });
}

async function setUp(pull: Pull) {
  const now = { pull };
  listing(now);
  const a = await signInWithGithub();
  const listed = async () => {
    const res = await a.send("/api/platforms/pulls");
    expect(res.status).toBe(200);
    const pulls = ((await res.json()) as Listed).platforms[0]?.pulls ?? [];
    const p = pulls[0];
    return p && { unread: p.unread, reason: p.unreadReason, head: p.head };
  };
  const post = (path: string, body: unknown) =>
    a.send(`/api/pulls/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const seen = (updatedAt: string, head: string | null = HEAD, repo = "octo/api") =>
    post("seen", { platform: "github", repo, number: 7, updatedAt, head });
  return { now, listed, post, seen };
}

describe("unread pull requests in the inbox", () => {
  it("shows a pull request never seen as new, and as read once its page marked it", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    expect(await t.listed()).toEqual({ unread: true, reason: "new", head: HEAD });
    const res = await t.seen(T0, HEAD, "Octo/API");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: 1 });
    expect(await t.listed()).toEqual({ unread: false, reason: undefined, head: HEAD });
  });

  it("says what changed since: new commits, a merge, other activity", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    await t.seen(T0);
    t.now.pull = { updatedAt: T1, head: NEXT };
    expect((await t.listed())?.reason).toBe("commits");
    t.now.pull = { updatedAt: T1, head: HEAD, state: "MERGED", mergedAt: T1 };
    expect((await t.listed())?.reason).toBe("merged");
    t.now.pull = { updatedAt: T1, head: HEAD };
    expect((await t.listed())?.reason).toBe("activity");
  });

  it("shows a new ocra review of it as unread, though the platform says nothing changed", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    await t.seen(T0);
    const [account] = await db.select().from(schema.accounts);
    await scoped(db, account?.id ?? "").insert("reviews", {
      id: "r1",
      runId: "run-1",
      repoHash: "h",
      source: "local",
      prRepository: "https://github.com/octo/api",
      prNumber: 7,
      createdAt: new Date(Date.now() + 1000),
    });
    expect((await t.listed())?.reason).toBe("ocra_review");
  });

  it("never moves a mark back to an older updatedAt", async () => {
    const t = await setUp({ updatedAt: T1, head: NEXT });
    await t.seen(T1, NEXT);
    const stale = await t.seen(T0, HEAD);
    expect(await stale.json()).toEqual({ changed: 0 });
    expect(await t.listed()).toMatchObject({ unread: false });
  });

  it("marks a list unread and read again, deduplicated and bounded", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    const pull = { platform: "github", repo: "octo/api", number: 7 };
    const unread = await t.post("seen/bulk", { read: false, pulls: [pull, pull] });
    expect(await unread.json()).toEqual({ changed: 1 });
    expect((await t.listed())?.reason).toBe("marked");
    const read = await t.post("seen/bulk", {
      read: true,
      pulls: [{ ...pull, repo: "Octo/API", updatedAt: T0, head: HEAD }],
    });
    expect(await read.json()).toEqual({ changed: 1 });
    expect(await t.listed()).toMatchObject({ unread: false });

    const many = Array.from({ length: MAX_SEEN_BULK + 1 }, (_, i) => ({ ...pull, number: i + 1 }));
    expect((await t.post("seen/bulk", { read: false, pulls: many })).status).toBe(400);
    expect((await t.post("seen/bulk", { read: true, pulls: [pull] })).status).toBe(400);
  });

  it("refuses an updatedAt in the future, a bad head and a sign-in missing", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect((await t.seen(later)).status).toBe(400);
    expect((await t.seen(T0, "not-a-sha")).status).toBe(400);
    const { call } = await import("./helpers.js");
    expect((await call("/api/pulls/seen", { method: "POST" })).status).toBe(401);
  });
});

describe("pullUnread", () => {
  const seen = { updatedAt: Date.parse(T0), head: HEAD, unread: false, seenAt: Date.parse(T0) };
  const pull = { updatedAt: T0, head: HEAD, mergedAt: null };

  it("is read while nothing changed, and an older listing changes nothing", () => {
    expect(pullUnread(pull, seen, null)).toEqual({ unread: false });
    expect(
      pullUnread({ ...pull, head: NEXT }, { ...seen, updatedAt: Date.parse(T1) }, null),
    ).toEqual({ unread: false });
  });

  it("puts a hand mark first, and commits before an ocra review", () => {
    expect(pullUnread(pull, { ...seen, unread: true }, null).unreadReason).toBe("marked");
    const moved = { ...pull, updatedAt: T1, head: NEXT };
    expect(pullUnread(moved, seen, Date.parse(T1)).unreadReason).toBe("commits");
    expect(pullUnread(pull, seen, Date.parse(T1)).unreadReason).toBe("ocra_review");
  });

  it("calls a head the listing does not name activity", () => {
    expect(pullUnread({ ...pull, updatedAt: T1, head: null }, seen, null).unreadReason).toBe(
      "activity",
    );
  });
});

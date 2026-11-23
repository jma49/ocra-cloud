import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceRetention } from "../src/db/retention.js";
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

type Pull = {
  updatedAt: string;
  head: string;
  createdAt?: string;
  state?: string;
  mergedAt?: string | null;
};
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
                    createdAt: now.pull.createdAt ?? T0,
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
              assigned: { issueCount: 0, nodes: [] },
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
  return { a, now, listed, post, seen };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const inboxSince = async () => (await db.select().from(schema.accounts))[0]?.inboxSince ?? null;

describe("unread pull requests in the inbox", () => {
  it("shows a fresh account nothing unread, and keeps the baseline where it was first set", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    expect(await inboxSince()).toBeNull();
    expect(await t.listed()).toEqual({ unread: false, reason: undefined, head: HEAD });
    const since = await inboxSince();
    expect(since).not.toBeNull();
    await t.listed();
    expect(await inboxSince()).toEqual(since);
    const exported = (await (await t.a.send("/api/export")).json()) as {
      account: { inboxSince: string };
    };
    expect(exported.account.inboxSince).toBe(since?.toISOString());
  });

  it("shows a pull request opened or updated after the baseline unread until seen", async () => {
    const t = await setUp({ updatedAt: T0, head: HEAD });
    await t.listed();
    const later = new Date(Date.now() + 1000).toISOString();
    t.now.pull = { updatedAt: later, head: HEAD };
    expect(await t.listed()).toMatchObject({ unread: true, reason: "activity" });
    t.now.pull = { updatedAt: later, head: HEAD, createdAt: later };
    expect(await t.listed()).toEqual({ unread: true, reason: "new", head: HEAD });
    const res = await t.seen(T0, HEAD, "Octo/API");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: 1 });
    expect((await t.listed())?.reason).toBe("activity");
  });

  it("keeps a pull request read once retention deletes its mark", async () => {
    const t = await setUp({
      updatedAt: ago(150).toISOString(),
      head: HEAD,
      createdAt: ago(180).toISOString(),
    });
    expect(await t.listed()).toMatchObject({ unread: false });
    // A baseline older than retention: only the cutoff keeps it read.
    const since = ago(200);
    await db.update(schema.accounts).set({ inboxSince: since });
    await t.seen(ago(150).toISOString());
    await db.update(schema.pullSeen).set({ seenAt: ago(120) });
    expect(await t.listed()).toMatchObject({ unread: false });

    await enforceRetention(db);
    expect(await db.select().from(schema.pullSeen)).toEqual([]);
    expect(await t.listed()).toMatchObject({ unread: false });
    expect(await inboxSince()).toEqual(since);
    t.now.pull = { ...t.now.pull, updatedAt: new Date().toISOString(), head: NEXT };
    expect((await t.listed())?.reason).toBe("activity");
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

describe("inbox baseline", () => {
  it("is set once per account, by its own id only, and never trails retention", async () => {
    await db.delete(schema.accounts);
    await db.insert(schema.accounts).values([
      { id: "a", login: "a" },
      { id: "b", login: "b" },
    ]);
    const first = Date.parse(T0);
    expect(await scoped(db, "a").pullSeen.baseline(null, 90, first)).toBe(first);
    expect(await scoped(db, "a").pullSeen.baseline(null, 90, first + 1000)).toBe(first);
    const rows = await db.select().from(schema.accounts).orderBy(schema.accounts.id);
    expect(rows.map((r) => [r.id, r.inboxSince?.getTime() ?? null])).toEqual([
      ["a", first],
      ["b", null],
    ]);
    const late = first + 200 * DAY;
    expect(await scoped(db, "a").pullSeen.baseline(new Date(first), 90, late)).toBe(
      late - 90 * DAY,
    );
    const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, "a"));
    expect(a?.inboxSince?.getTime()).toBe(first);
  });
});

describe("pullUnread", () => {
  const seen = { updatedAt: Date.parse(T0), head: HEAD, unread: false, seenAt: Date.parse(T0) };
  const pull = { createdAt: T0, updatedAt: T0, head: HEAD, mergedAt: null };
  const since = Date.parse(T0);

  it("is read while nothing changed, and an older listing changes nothing", () => {
    expect(pullUnread(pull, seen, null, since)).toEqual({ unread: false });
    expect(
      pullUnread({ ...pull, head: NEXT }, { ...seen, updatedAt: Date.parse(T1) }, null, since),
    ).toEqual({ unread: false });
  });

  it("puts a hand mark first, and commits before an ocra review", () => {
    expect(pullUnread(pull, { ...seen, unread: true }, null, since).unreadReason).toBe("marked");
    const moved = { ...pull, updatedAt: T1, head: NEXT };
    expect(pullUnread(moved, seen, Date.parse(T1), since).unreadReason).toBe("commits");
    expect(pullUnread(pull, seen, Date.parse(T1), since).unreadReason).toBe("ocra_review");
  });

  it("reads a pull with no mark against the baseline", () => {
    expect(pullUnread(pull, undefined, null, since)).toEqual({ unread: false });
    const moved = { ...pull, updatedAt: T1, head: NEXT };
    expect(pullUnread(moved, undefined, null, since).unreadReason).toBe("activity");
    expect(pullUnread({ ...moved, mergedAt: T1 }, undefined, null, since).unreadReason).toBe(
      "merged",
    );
    expect(pullUnread({ ...moved, createdAt: T1 }, undefined, null, since).unreadReason).toBe(
      "new",
    );
    expect(pullUnread(pull, undefined, Date.parse(T1), since).unreadReason).toBe("ocra_review");
  });

  it("calls a head the listing does not name activity", () => {
    expect(pullUnread({ ...pull, updatedAt: T1, head: null }, seen, null, since).unreadReason).toBe(
      "activity",
    );
  });
});

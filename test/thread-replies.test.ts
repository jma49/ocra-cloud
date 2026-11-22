import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellPullEvent } from "../src/notify/pull-events.js";
import { tellGithubHook, tellGitlabNote } from "../src/notify/pull-hooks.js";
import { keepGithubThread } from "../src/notify/thread-hooks.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import type { PlatformPull } from "../src/platforms/pulls.js";
import { pullRepliesWaiting } from "../src/pull-unread.js";
import { type NotifyEvent, pullUnread } from "../src/shared/index.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// Who started each review thread is kept from webhooks, so a reply by
// someone else tells the starter (thread_replied) and counts in the inbox
// as a reply waiting; never their own reply, a bot's, or a reply in a
// thread whose start ocra never saw.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const OTHER = 7;

function chats() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

const out = (): Outbox => ({
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
});

async function setUp(events: NotifyEvent[], extra: { quietHours?: unknown } = {}) {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "Octo/API",
  });
  const repo = (await data.get("reviewRepos", repoId)) as NonNullable<
    Awaited<ReturnType<typeof data.get<"reviewRepos">>>
  >;
  if (events.length > 0) {
    const added = await call("/api/notifications/channels", {
      method: "POST",
      auth: me.auth,
      json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events, ...extra },
    });
    expect(added.ok).toBe(true);
  }
  return { me, data, repo };
}

const user = (id: number, login: string, type = "User") => ({ id, login, type });

const reviewComment = (
  id: number,
  by: ReturnType<typeof user>,
  opts: { replyTo?: number; at?: string; body?: string; number?: number } = {},
) => ({
  action: "created",
  pull_request: { number: opts.number ?? 5, title: "Add <!channel> cache", user: user(99, "x") },
  comment: {
    id,
    body: opts.body ?? "Why this <!channel> lock?",
    user: by,
    created_at: opts.at ?? "2026-11-02T10:00:00Z",
    pull_request_review_id: 9000 + id,
    ...(opts.replyTo !== undefined ? { in_reply_to_id: opts.replyTo } : {}),
  },
  repository: { id: 11 },
});

const hook = (body: unknown) => tellGithubHook(db, out(), "pull_request_review_comment", body);

describe("GitHub review threads", () => {
  it("keeps a start and tells its starter of someone else's reply, once, with a plain excerpt", async () => {
    const posted = chats();
    const { data } = await setUp(["thread_replied"]);
    expect(await hook(reviewComment(100, user(ME, "mona")))).toBe(0);
    const [start] = await data.list("reviewThreads");
    expect(start).toMatchObject({ threadKey: "100", starterId: String(ME), number: 5 });
    const reply = reviewComment(101, user(OTHER, "hubot"), {
      replyTo: 100,
      at: "2026-11-02T11:00:00Z",
      body: "Because @here `secret` it races",
    });
    expect(await hook(reply)).toBe(1);
    expect(await hook(reply)).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("hubot replied in your review thread");
    expect(posted[0]).toContain("it races");
    expect(posted[0]).not.toContain("<!channel>");
    expect(posted[0]).not.toContain("secret");
  });

  it("keeps the first start of a thread: a redelivery from someone else changes nothing", async () => {
    const { data } = await setUp([]);
    await hook(reviewComment(100, user(ME, "mona")));
    await hook(reviewComment(100, user(OTHER, "hubot")));
    expect((await data.list("reviewThreads")).map((t) => t.starterId)).toEqual([String(ME)]);
  });

  it("tells nobody of the starter's own reply, a bot's, or a reply in a thread not on record", async () => {
    const posted = chats();
    const { data } = await setUp(["thread_replied"]);
    await hook(reviewComment(100, user(ME, "mona")));
    expect(await hook(reviewComment(101, user(ME, "mona"), { replyTo: 100 }))).toBe(0);
    expect(await hook(reviewComment(102, user(3, "ocra[bot]", "Bot"), { replyTo: 100 }))).toBe(0);
    expect(await hook(reviewComment(103, user(OTHER, "hubot"), { replyTo: 55 }))).toBe(0);
    expect(posted).toEqual([]);
    const [thread] = await data.list("reviewThreads");
    expect(thread?.repliedAt).toBeNull();
    expect(thread?.starterRepliedAt).not.toBeNull();
    expect(await data.count("reviewThreads")).toBe(1);
  });

  it("tells nobody of a reply in someone else's thread, and keeps no bot's start", async () => {
    const posted = chats();
    const { data } = await setUp(["thread_replied"]);
    await hook(reviewComment(100, user(OTHER, "hubot")));
    expect(await hook(reviewComment(101, user(8, "ada"), { replyTo: 100 }))).toBe(0);
    await hook(reviewComment(200, user(3, "ocra[bot]", "Bot")));
    expect(posted).toEqual([]);
    expect((await data.list("reviewThreads")).map((t) => t.threadKey)).toEqual(["100"]);
  });

  it("holds a reply in quiet hours, once", async () => {
    const posted = chats();
    const { data, repo } = await setUp(["thread_replied"], { quietHours: { start: 22, end: 7 } });
    await hook(reviewComment(100, user(ME, "mona")));
    const night = new Date("2026-11-02T23:30:00Z");
    const events = await keepGithubThread(
      data,
      "pull_request_review_comment",
      reviewComment(101, user(OTHER, "hubot"), { replyTo: 100 }),
      repo.id,
      night,
    );
    expect(events.map((e) => e.kind)).toEqual(["thread_replied"]);
    expect(await tellPullEvent(db, data, out(), repo, events, night)).toEqual([]);
    expect(await tellPullEvent(db, data, out(), repo, events, night)).toEqual([]);
    expect(posted).toEqual([]);
    const held = await data.list("notifyHeld");
    expect(held.map((h) => [h.event, h.number])).toEqual([["thread_replied", 5]]);
    expect(held[0]?.line).toContain("hubot replied in your review thread");
  });
});

describe("GitLab discussions", () => {
  const note = (
    id: number,
    by: { id: number; username: string; bot?: boolean },
    discussion: string,
    type: string | null,
  ) => ({
    object_kind: "note",
    user: by,
    object_attributes: {
      id,
      note: "please look",
      noteable_type: "MergeRequest",
      type,
      discussion_id: discussion,
      created_at: "2026-11-02 10:00:00 UTC",
    },
    merge_request: { iid: 3, title: "T", author_id: 99 },
    project: { id: 9 },
  });

  async function gitlab() {
    const posted = chats();
    const { data, repo } = await setUp(["thread_replied"]);
    await data.insert("platformLinks", {
      platform: "gitlab",
      host: "gitlab.test",
      wrappedKey: "w",
      ciphertext: "c",
      userId: String(ME),
      login: "lab-mona",
    });
    return { posted, data, repo: { ...repo, platform: "gitlab" as const, host: "gitlab.test" } };
  }

  it("keeps a plain comment as its discussion's start and tells its starter of a reply", async () => {
    const { posted, data, repo } = await gitlab();
    expect(
      await tellGitlabNote(db, out(), repo, note(1, { id: ME, username: "lab-mona" }, "d1", null)),
    ).toBe(0);
    expect((await data.list("reviewThreads")).map((t) => t.threadKey)).toEqual(["d1"]);
    const reply = note(2, { id: OTHER, username: "hubot" }, "d1", "DiscussionNote");
    expect(await tellGitlabNote(db, out(), repo, reply)).toBe(1);
    expect(posted[0]).toContain("hubot replied in your review thread");
    expect(
      await tellGitlabNote(
        db,
        out(),
        repo,
        note(3, { id: ME, username: "lab-mona" }, "d1", "DiscussionNote"),
      ),
    ).toBe(0);
    const bot = note(4, { id: 5, username: "project_9_bot_x" }, "d1", "DiscussionNote");
    expect(await tellGitlabNote(db, out(), repo, bot)).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it("never takes a diff note of an unknown discussion for its start", async () => {
    const { posted, data, repo } = await gitlab();
    const first = note(1, { id: ME, username: "lab-mona" }, "d2", "DiffNote");
    await tellGitlabNote(db, out(), repo, first);
    const reply = note(2, { id: OTHER, username: "hubot" }, "d2", "DiffNote");
    expect(await tellGitlabNote(db, out(), repo, reply)).toBe(0);
    expect(await data.count("reviewThreads")).toBe(0);
    expect(posted).toEqual([]);
  });
});

describe("replies waiting in the inbox", () => {
  const github = { kind: "github", host: "github.com" } as CodePlatform;
  const pull = (number: number, repo = "Octo/API") => ({ repo, number }) as PlatformPull;

  it("counts the user's threads with a reply newer than their own and than what they saw", async () => {
    const { data } = await setUp([]);
    await hook(reviewComment(100, user(ME, "mona")));
    await hook(
      reviewComment(101, user(OTHER, "hubot"), { replyTo: 100, at: "2026-11-02T11:00:00Z" }),
    );
    await hook(reviewComment(200, user(ME, "mona")));
    await hook(
      reviewComment(201, user(OTHER, "hubot"), { replyTo: 200, at: "2026-11-02T11:00:00Z" }),
    );
    await hook(reviewComment(202, user(ME, "mona"), { replyTo: 200, at: "2026-11-02T12:00:00Z" }));
    await hook(reviewComment(300, user(OTHER, "hubot")));
    await hook(reviewComment(301, user(8, "ada"), { replyTo: 300, at: "2026-11-02T11:00:00Z" }));
    await hook(reviewComment(400, user(ME, "mona"), { number: 6 }));
    await hook(
      reviewComment(401, user(OTHER, "hubot"), {
        replyTo: 400,
        number: 6,
        at: "2026-11-02T11:00:00Z",
      }),
    );
    const listed = [{ platform: github, pulls: [pull(5), pull(6), pull(7)] }];
    const before = Date.parse("2026-11-02T10:30:00Z");
    const after = Date.parse("2026-11-02T11:30:00Z");
    const mark = { updatedAt: after, head: null, unread: false, seenAt: after };
    const repliesOf = await pullRepliesWaiting(
      db,
      data,
      listed,
      (_, p) => (p.number === 6 ? mark : undefined),
      before,
    );
    expect([5, 6, 7].map((n) => repliesOf(github, pull(n)))).toEqual([1, 0, 0]);
    const unread = await pullRepliesWaiting(
      db,
      data,
      listed,
      (_, p) => (p.number === 6 ? { ...mark, unread: true, updatedAt: 0 } : undefined),
      after,
    );
    expect([5, 6].map((n) => unread(github, pull(n)))).toEqual([0, 1]);
  });

  it("keeps threads under the account that enrolled the repository only", async () => {
    const { data } = await setUp([]);
    await hook(reviewComment(100, user(ME, "mona")));
    const other = await signIn(OTHER + 100, "someone");
    expect(await scoped(db, other.account.id).count("reviewThreads")).toBe(0);
    expect(await data.count("reviewThreads")).toBe(1);
  });

  it("says replies are why a pull is unread, after an ocra review", () => {
    const t0 = "2026-11-02T10:00:00Z";
    const seen = { updatedAt: Date.parse(t0), head: "a", unread: false, seenAt: Date.parse(t0) };
    const p = { createdAt: t0, updatedAt: "2026-11-02T11:00:00Z", head: "a", mergedAt: null };
    expect(pullUnread(p, seen, null, 0, 2).unreadReason).toBe("replies");
    expect(pullUnread(p, seen, null, 0).unreadReason).toBe("activity");
    expect(pullUnread(p, seen, Date.parse(p.updatedAt), 0, 2).unreadReason).toBe("ocra_review");
  });
});

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "../src/auto-review/work.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellGithubHook } from "../src/notify/pull-hooks.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

// The console's notification centre: the notices the account's own user is
// told of, kept whether or not a channel hears of them, each event once,
// with read marks, paged newest first.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const ME = 42;
const OTHER = 7;
const TOKEN = `ghp_${"A1b2".repeat(9)}`;

const out = (): Outbox => ({
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
});

type Item = {
  id: string;
  kind: string;
  at: string;
  read: boolean;
  title: string;
  subtitle?: string;
  link: string;
  repo?: string;
  pull?: number;
};
type Page = { items: Item[]; unread: number; next?: string };

async function setUp() {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  return { me, data, repoId };
}

const user = (id: number, login: string, type = "User") => ({ id, login, type });
const comment = (body: string, by = user(OTHER, "hubot"), id = 500) => ({
  action: "created",
  issue: { number: 5, title: "Add cache", user: user(ME, "mona"), pull_request: {} },
  comment: { id, body, user: by },
  repository: { id: 11 },
});

async function feed(auth: Record<string, string>, query = ""): Promise<Page> {
  const res = await call(`/api/notifications/feed${query}`, { auth });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

async function unread(auth: Record<string, string>): Promise<number> {
  const res = await call("/api/notifications/feed/unread", { auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { unread: number }).unread;
}

const markRead = (auth: Record<string, string>, json: unknown) =>
  call("/api/notifications/feed/read", { method: "POST", auth, json });

describe("a pull request event of the user's", () => {
  it("is kept with no channel, once per comment, its excerpt redacted", async () => {
    const { me } = await setUp();
    const body = comment(`@mona can you look? token ${TOKEN}`);
    await tellGithubHook(db, "github.com", out(), "issue_comment", body);
    await tellGithubHook(db, "github.com", out(), "issue_comment", body);
    const page = await feed(me.auth);
    expect(page.unread).toBe(1);
    expect(page.next).toBeUndefined();
    expect(page.items).toEqual([
      {
        id: expect.any(String),
        kind: "mentioned",
        at: expect.any(String),
        read: false,
        title: "hubot mentioned you",
        subtitle: "Add cache · “mona can you look? token redacted”",
        link: "/pull/github/octo%2Fapi/5",
        repo: "octo/api",
        pull: 5,
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(TOKEN);
    expect(JSON.stringify(page)).not.toContain(TOKEN.slice(4));
  });

  it("keeps nothing of the user's own comment", async () => {
    const { me } = await setUp();
    const own = comment("@mona note to self", user(ME, "mona"));
    await tellGithubHook(db, "github.com", out(), "issue_comment", own);
    expect((await feed(me.auth)).items).toEqual([]);
  });
});

describe("read marks", () => {
  it("mark notices read by id, and all up to a time", async () => {
    const { me } = await setUp();
    for (const id of [500, 501, 502]) {
      await tellGithubHook(
        db,
        "github.com",
        out(),
        "issue_comment",
        comment("LGTM", undefined, id),
      );
    }
    const { items } = await feed(me.auth);
    expect(items).toHaveLength(3);
    expect(await unread(me.auth)).toBe(3);
    const newest = items[0] as Item;
    const marked = await markRead(me.auth, { ids: [newest.id] });
    expect(await marked.json()).toEqual({ unread: 2 });
    expect((await feed(me.auth)).items.map((i) => i.read)).toEqual([true, false, false]);
    const all = await markRead(me.auth, { before: newest.at });
    expect(await all.json()).toEqual({ unread: 0 });
    expect((await feed(me.auth)).items.every((i) => i.read)).toBe(true);
  });

  it("leave another account's notices as they are", async () => {
    const { me } = await setUp();
    await tellGithubHook(db, "github.com", out(), "issue_comment", comment("LGTM"));
    const [item] = (await feed(me.auth)).items;
    const other = await signIn(99, "other");
    expect(await (await markRead(other.auth, { ids: [item?.id] })).json()).toEqual({ unread: 0 });
    expect(await unread(me.auth)).toBe(1);
    expect((await feed(other.auth)).items).toEqual([]);
  });

  it("refuse a body that names neither ids nor a time", async () => {
    const { me } = await setUp();
    expect((await markRead(me.auth, {})).status).toBe(400);
    expect((await markRead(me.auth, { ids: [] })).status).toBe(400);
    expect((await markRead(me.auth, { before: "yesterday" })).status).toBe(400);
  });
});

describe("the feed's pages", () => {
  it("go newest first, by a cursor, and refuse one that is not", async () => {
    const { me } = await setUp();
    for (const id of [500, 501, 502]) {
      await tellGithubHook(
        db,
        "github.com",
        out(),
        "issue_comment",
        comment("LGTM", undefined, id),
      );
    }
    const all = (await feed(me.auth)).items.map((i) => i.id);
    const first = await feed(me.auth, "?limit=2");
    expect(first.items.map((i) => i.id)).toEqual(all.slice(0, 2));
    expect(first.next).toEqual(expect.any(String));
    const second = await feed(me.auth, `?limit=2&before=${first.next}`);
    expect(second.items.map((i) => i.id)).toEqual(all.slice(2));
    expect(second.next).toBeUndefined();
    const bad = await call("/api/notifications/feed?before=nope", { auth: me.auth });
    expect(bad.status).toBe(400);
  });

  it("are the web session's only", async () => {
    const cli = await signInCli(ME, "mona");
    expect((await call("/api/notifications/feed", { auth: cli.auth })).status).toBe(403);
    expect((await call("/api/notifications/feed/unread")).status).toBe(401);
  });
});

describe("a hosted job that gives up", () => {
  it("is kept once, linking to its pull request", async () => {
    const { me, data, repoId } = await setUp();
    const jobId = await data.insert("reviewJobs", {
      reviewRepoId: repoId,
      number: 9,
      head: "a".repeat(40),
      state: "running",
      attempts: 1,
    });
    const ref = { kind: "review" as const, id: jobId, accountId: me.account.id, attempts: 1 };
    const now = new Date();
    await settle({ db, dailyCalls: 100 }, ref, "repo_gone", now);
    await settle({ db, dailyCalls: 100 }, ref, "repo_gone", now);
    const { items } = await feed(me.auth);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "job_failed",
        title: "ocra’s review could not finish",
        link: "/pull/github/octo%2Fapi/9",
        repo: "octo/api",
        pull: 9,
      }),
    ]);
  });
});

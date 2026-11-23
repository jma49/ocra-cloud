import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordGithubRequest, recordGitlabRequests } from "../src/auto-review/requests.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { hourIn, isQuiet, runReminders } from "../src/notify/reminders.js";
import type { NotifyChannelView, NotifyEvent } from "../src/shared/index.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// Review reminders: a review asked of the account's own platform user, or
// its own pull request no one reviewed, told once it waited the channel's
// hours, from what the webhooks stored; once per ask, in one message per
// channel, never in quiet hours, never for a closed pull request or another
// account's repository.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const OTHER = 7;
const now = new Date(Date.UTC(2026, 10, 20, 12, 30));
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

function chats() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
};

async function account(githubId: number, login: string, repoId: string, platformRepoId: string) {
  const me = await signIn(githubId, login);
  const data = scoped(db, me.account.id);
  await data.insert("reviewRepos", {
    id: repoId,
    platform: "github",
    host: "github.com",
    platformRepoId,
    fullName: `${login}/api`,
  });
  return { me, data };
}

async function addChannel(
  auth: Record<string, string>,
  extra: { events?: NotifyEvent[]; reminderHours?: number | null; quietHours?: unknown } = {},
) {
  const res = await call("/api/notifications/channels", {
    method: "POST",
    auth,
    json: {
      kind: "slack",
      url: SLACK,
      name: "team",
      when: "blocking",
      events: ["review_waiting", "pull_waiting"],
      reminderHours: 4,
      ...extra,
    },
  });
  return { res, channel: ((await res.json()) as { channel: NotifyChannelView }).channel };
}

/** A GitHub ask of reviewer on pull number of the repository with that platform id. */
const ask = (repo: number, number: number, reviewer: number, at: Date) =>
  recordGithubRequest(db, "github.com", "pull_request", {
    action: "review_requested",
    number,
    pull_request: { updated_at: at.toISOString() },
    requested_reviewer: { id: reviewer },
    repository: { id: repo },
  });

const flow = (data: ReturnType<typeof scoped>, number: number, extra: object = {}) =>
  data.pullFlows.record({
    reviewRepoId: "repo",
    number,
    title: `Pull ${number}`,
    author: "hubot",
    authorId: String(OTHER),
    draft: false,
    size: 3,
    openedAt: ago(30),
    seenAt: ago(1),
    ...extra,
  });

describe("reminders of a review asked of the user", () => {
  it("go once the ask has waited the channel's hours, once per ask", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await addChannel(me.auth);
    await flow(data, 5);
    await ask(11, 5, ME, ago(3));
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
    const later = new Date(now.getTime() + 2 * HOUR);
    await Promise.all([
      runReminders(db, out, "github.com", later),
      runReminders(db, out, "github.com", later),
    ]);
    await runReminders(db, out, "github.com", new Date(now.getTime() + 3 * HOUR));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Waiting for your review (1):");
    expect(posted[0]).toContain("<https://console.test/pull/github/mona%2Fapi/5|mona/api#5>");
    expect(posted[0]).toContain("Pull 5 · waiting 5h 0m");
  });

  it("lists every waiting pull request of a channel in one message, grouped", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await addChannel(me.auth);
    await flow(data, 5);
    await flow(data, 6);
    await flow(data, 8, { authorId: String(ME), author: "mona", readyAt: ago(9) });
    await ask(11, 5, ME, ago(6));
    await ask(11, 6, ME, ago(24));
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
    const text = posted[0] ?? "";
    expect(text).toContain("Waiting for your review (2):");
    expect(text).toContain("Your pull requests waiting for a review (1):");
    expect(text.indexOf("mona/api#6")).toBeLessThan(text.indexOf("mona/api#5"));
    expect(text).toContain("mona/api#8");
  });

  it("skips an ask the user answered, and reminds of a new ask after it", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await addChannel(me.auth);
    await flow(data, 5);
    await ask(11, 5, ME, ago(10));
    await recordGithubRequest(db, "github.com", "pull_request_review", {
      action: "submitted",
      review: { user: { id: ME }, submitted_at: ago(9).toISOString() },
      pull_request: { number: 5 },
      repository: { id: 11 },
    });
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
    await ask(11, 5, ME, ago(5));
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
  });

  it("skips merged, closed and draft pull requests, and asks of someone else", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await addChannel(me.auth);
    for (const n of [1, 2, 3, 4]) await flow(data, n, n === 3 ? { draft: true } : {});
    for (const n of [1, 2, 3]) await ask(11, n, ME, ago(6));
    await ask(11, 4, OTHER, ago(6));
    for (const [number, merged] of [
      [1, true],
      [2, false],
    ] as const) {
      await data.insert("closedPulls", {
        reviewRepoId: "repo",
        number,
        title: "T",
        merged,
        closedAt: ago(2),
      });
    }
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
  });

  it("follows GitLab's reviewers and approvals", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await data.insert("platformLinks", {
      platform: "gitlab",
      host: "gitlab.example.com",
      wrappedKey: "k",
      ciphertext: "c",
      userId: "900",
    } as never);
    await data.insert("reviewRepos", {
      id: "lab",
      platform: "gitlab",
      host: "gitlab.example.com",
      platformRepoId: "77",
      fullName: "team/web",
    });
    const repo = { id: "lab", accountId: me.account.id, host: "gitlab.example.com" };
    const changed = (previous: number[], current: number[]) => ({
      object_attributes: { iid: 3, action: "update" },
      changes: {
        reviewers: {
          previous: previous.map((id) => ({ id, username: `u${id}` })),
          current: current.map((id) => ({ id, username: `u${id}` })),
        },
      },
    });
    const approved = {
      object_attributes: { iid: 3, action: "approved", author_id: 1 },
      user: { id: 900, username: "me" },
    };
    expect(await recordGitlabRequests(db, repo, changed([], [900]), ago(7))).toBe(1);
    await recordGitlabRequests(db, repo, approved, ago(6));
    await addChannel(me.auth);
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
    await recordGitlabRequests(db, repo, changed([900], []), ago(5.5));
    await recordGitlabRequests(db, repo, changed([], [900]), ago(5));
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("team/web#3");
  });
});

describe("reminders of the user's own pull request", () => {
  it("go once it waited for any review, never after one", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    await addChannel(me.auth, { events: ["pull_waiting"], reminderHours: 8 });
    const mine = { authorId: String(ME), author: "mona" };
    await flow(data, 5, { ...mine, readyAt: ago(9) });
    await flow(data, 6, { ...mine, readyAt: ago(7) });
    await flow(data, 7, { ...mine, readyAt: ago(9) });
    await data.pullFlows.review(
      {
        reviewRepoId: "repo",
        number: 7,
        title: "T",
        author: "mona",
        draft: false,
        size: 1,
        seenAt: ago(1),
      },
      { reviewKey: "github:1", reviewer: "hubot", approved: false, submittedAt: ago(2) },
    );
    // An ask of the user is not this channel's.
    await ask(11, 5, ME, ago(9));
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Your pull requests waiting for a review (1):");
    expect(posted[0]).toContain("mona/api#5");
    expect(posted[0]).not.toContain("Waiting for your review");
  });
});

describe("quiet hours", () => {
  it("read the hour in the account's time zone, over midnight too", () => {
    expect(hourIn(now, "UTC")).toBe(12);
    expect(hourIn(now, "Asia/Tokyo")).toBe(21);
    expect(isQuiet({ quietStart: 22, quietEnd: 7 }, 23)).toBe(true);
    expect(isQuiet({ quietStart: 22, quietEnd: 7 }, 6)).toBe(true);
    expect(isQuiet({ quietStart: 22, quietEnd: 7 }, 7)).toBe(false);
    expect(isQuiet({ quietStart: 9, quietEnd: 17 }, 12)).toBe(true);
    expect(isQuiet({ quietStart: null, quietEnd: null }, 12)).toBe(false);
  });

  it("hold a reminder until they end", async () => {
    const { me, data } = await account(ME, "mona", "repo", "11");
    const put = await call("/api/notifications/time-zone", {
      method: "PUT",
      auth: me.auth,
      json: { timeZone: "Asia/Tokyo" },
    });
    expect(await put.json()).toEqual({ timeZone: "Asia/Tokyo" });
    await addChannel(me.auth, { quietHours: { start: 21, end: 22 } });
    await flow(data, 5);
    await ask(11, 5, ME, ago(6));
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
    await runReminders(db, out, "github.com", new Date(now.getTime() + HOUR));
    expect(posted).toHaveLength(1);
  });
});

describe("the settings", () => {
  it("take only the allowed hours, distinct quiet hours and a known time zone", async () => {
    const { me } = await account(ME, "mona", "repo", "11");
    expect((await addChannel(me.auth, { reminderHours: 5 })).res.status).toBe(400);
    expect((await addChannel(me.auth, { quietHours: { start: 3, end: 3 } })).res.status).toBe(400);
    const { channel } = await addChannel(me.auth, { quietHours: { start: 22, end: 7 } });
    expect(channel).toMatchObject({ reminderHours: 4, quietHours: { start: 22, end: 7 } });
    const off = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: me.auth,
      json: { reminderHours: null, quietHours: null },
    });
    expect(((await off.json()) as { channel: NotifyChannelView }).channel).toMatchObject({
      reminderHours: null,
      quietHours: null,
    });
    const bad = await call("/api/notifications/time-zone", {
      method: "PUT",
      auth: me.auth,
      json: { timeZone: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);
    const read = await call("/api/notifications/time-zone", { auth: me.auth });
    expect(await read.json()).toEqual({ timeZone: "UTC" });
  });
});

describe("isolation", () => {
  it("never reminds an account of another account's repository", async () => {
    const a = await account(ME, "mona", "repo", "11");
    const b = await account(OTHER, "hubot", "repo-b", "22");
    await addChannel(a.me.auth);
    await addChannel(b.me.auth);
    // An ask of A's user on B's repository, and an unreviewed pull request of A's user there.
    await b.data.pullFlows.record({
      reviewRepoId: "repo-b",
      number: 9,
      title: "B's",
      author: "mona",
      authorId: String(ME),
      draft: false,
      size: 1,
      readyAt: ago(9),
      seenAt: ago(1),
    });
    await ask(22, 9, ME, ago(9));
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
    expect(await a.data.count("notifySends")).toBe(0);
    expect(await b.data.count("notifySends")).toBe(0);
  });
});

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { githubCommentEvents } from "../src/notify/comment-hooks.js";
import { runHeld } from "../src/notify/held.js";
import type { Outbox } from "../src/notify/notify.js";
import { type PullEvent, tellPullEvent } from "../src/notify/pull-events.js";
import type { NotifyChannelView, NotifyEvent } from "../src/shared/index.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// Comment notices that come in a channel's quiet hours are held, then sent
// by the hourly run once the hours end in the account's time zone: one
// message per channel, newest first, each notice once however often the
// comment is delivered or the run goes, never after two days, never to
// another account.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const OTHER = 7;
// New York leaves daylight saving time at 2:00 on 2026-11-01: 07:00 that
// morning is 12:00 UTC, not 11:00.
const night = new Date("2026-11-01T04:30:00Z");
const beforeEnd = new Date("2026-11-01T11:47:00Z");
const afterEnd = new Date("2026-11-01T12:47:00Z");

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

async function setUp(
  githubId = ME,
  login = "mona",
  events: NotifyEvent[] = ["pull_commented", "mentioned", "review_requested"],
) {
  const me = await signIn(githubId, login);
  const data = scoped(db, me.account.id);
  const zone = await call("/api/notifications/time-zone", {
    method: "PUT",
    auth: me.auth,
    json: { timeZone: "America/New_York" },
  });
  expect(zone.status).toBe(200);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: String(githubId + 1000),
    fullName: `${login}/api`,
  });
  const repo = (await data.get("reviewRepos", repoId)) as NonNullable<
    Awaited<ReturnType<typeof data.get<"reviewRepos">>>
  >;
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: {
      kind: "slack",
      url: SLACK,
      name: "team",
      when: "blocking",
      events,
      quietHours: { start: 22, end: 7 },
    },
  });
  expect(added.ok).toBe(true);
  const { channel } = (await added.json()) as { channel: NotifyChannelView };
  return { me, data, repo, channel };
}

const user = (id: number, login: string) => ({ id, login, type: "User" });

const comment = (body: string, id: number, number = 5) => ({
  action: "created",
  issue: { number, title: "Add <!channel> cache", user: user(ME, "x"), pull_request: {} },
  comment: { id, body, user: user(OTHER, "hubot") },
  repository: { id: 11 },
});

const eventsOf = (repoId: string, body: string, id: number, number = 5) =>
  githubCommentEvents("issue_comment", comment(body, id, number), repoId);

describe("notices held in quiet hours", () => {
  it("hold comment notices and send them in one message once the hours end, DST or not", async () => {
    const posted = chats();
    const { data, repo } = await setUp();
    expect(await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night)).toEqual(
      [],
    );
    const mention = eventsOf(repo.id, "@mona see", 2, 6);
    const later = new Date(night.getTime() + HOUR);
    expect(await tellPullEvent(db, data, out, repo, mention, later)).toEqual([]);
    expect(posted).toEqual([]);
    expect(await data.count("notifyHeld")).toBe(2);

    await runHeld(db, out, beforeEnd);
    expect(posted).toEqual([]);
    await runHeld(db, out, afterEnd);
    expect(posted).toHaveLength(1);
    const [text] = posted;
    expect(text).toContain("2 notices");
    const lines = text?.split("\n") ?? [];
    expect(lines[1]).toContain("mona/api#6");
    expect(lines[1]).toContain("hubot mentioned you");
    expect(lines[2]).toContain("mona/api#5");
    expect(lines[2]).toContain("hubot commented on your pull request");
    expect(text).toContain("https://console.test/");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("@mona");
    expect(await data.count("notifyHeld")).toBe(0);

    await runHeld(db, out, new Date(afterEnd.getTime() + HOUR));
    expect(posted).toHaveLength(1);
  });

  it("name the newest ten and count the rest", async () => {
    const posted = chats();
    const { data, channel } = await setUp();
    for (let i = 0; i < 12; i++) {
      await data.insert("notifyHeld", {
        ...rows.notifyHeld(`n${i}`),
        channelId: channel.id,
        repo: "mona/api",
        number: i + 1,
        createdAt: new Date(night.getTime() + i * 60_000),
      });
    }
    await runHeld(db, out, afterEnd);
    expect(posted).toHaveLength(1);
    const lines = posted[0]?.split("\n") ?? [];
    expect(lines[0]).toContain("12 notices");
    expect(lines[1]).toContain("mona/api#12");
    expect(lines[10]).toContain("mona/api#3");
    expect(lines[11]).toBe("… and 2 more");
  });

  it("hold a comment delivered twice once, and never send it again after the hours", async () => {
    const posted = chats();
    const { data, repo } = await setUp();
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    expect(await data.count("notifyHeld")).toBe(1);
    expect(
      await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), afterEnd),
    ).toEqual([]);
    expect(posted).toEqual([]);
    await runHeld(db, out, afterEnd);
    expect(posted).toHaveLength(1);
  });

  it("go once when two runs flush at the same time", async () => {
    const posted = chats();
    const { data, repo, channel } = await setUp();
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "nice", 2), night);
    await Promise.all([runHeld(db, out, afterEnd), runHeld(db, out, afterEnd)]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("2 notices");

    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "again", 3), night);
    const since = new Date(0);
    const [a, b] = await Promise.all([
      data.notify.claimHeld(channel.id, since, 100, afterEnd),
      data.notify.claimHeld(channel.id, since, 100, afterEnd),
    ]);
    expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(1);
  });

  it("drop a notice held longer than two days", async () => {
    const posted = chats();
    const { data, channel } = await setUp();
    await data.insert("notifyHeld", {
      ...rows.notifyHeld("stale"),
      channelId: channel.id,
      createdAt: new Date(afterEnd.getTime() - 49 * HOUR),
    });
    await runHeld(db, out, afterEnd);
    expect(posted).toEqual([]);
  });

  it("tell each account only of its own", async () => {
    const posted = chats();
    const a = await setUp(ME, "mona");
    const b = await setUp(OTHER + 100, "lisa", ["pull_commented"]);
    await a.data.insert("notifyHeld", {
      ...rows.notifyHeld("of-a"),
      channelId: a.channel.id,
      repo: "mona/api",
    });
    // A row of account b that names a's channel is never sent there.
    await b.data.insert("notifyHeld", {
      ...rows.notifyHeld("of-b"),
      channelId: a.channel.id,
      repo: "lisa/api",
      eventKey: "comment:other",
      createdAt: night,
    });
    await runHeld(db, out, afterEnd);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("mona/api#1");
    expect(posted[0]).not.toContain("lisa/api");
    expect(await b.data.count("notifyHeld")).toBe(1);
  });

  it("leave a requested review as it is: sent at once, quiet hours or not", async () => {
    const posted = chats();
    const { data, repo } = await setUp();
    const asked: PullEvent = {
      kind: "review_requested",
      key: "github:requested:1",
      number: 5,
      concerns: String(ME),
      by: String(OTHER),
      what: "hubot asked for your review",
    };
    expect(await tellPullEvent(db, data, out, repo, [asked], night)).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(await data.count("notifyHeld")).toBe(0);
  });

  it("drop the notices of an event the channel stopped hearing about", async () => {
    const posted = chats();
    const { me, data, repo, channel } = await setUp();
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "@mona see", 2, 6), night);
    expect(await data.count("notifyHeld")).toBe(2);
    const res = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: me.auth,
      json: { events: ["mentioned"] },
    });
    expect(res.status).toBe(200);

    await runHeld(db, out, afterEnd);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("1 notice");
    expect(posted[0]).toContain("hubot mentioned you");
    expect(posted[0]).not.toContain("commented on your pull request");
    expect(await data.count("notifyHeld")).toBe(0);
  });

  it("send nothing to a channel that hears about none of its held events now", async () => {
    const posted = chats();
    const { me, data, repo, channel } = await setUp();
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: me.auth,
      json: { events: ["review_requested"] },
    });
    await runHeld(db, out, afterEnd);
    expect(posted).toEqual([]);
    expect(await data.count("notifyHeld")).toBe(0);
  });

  it("go with their channel when it is removed", async () => {
    const { me, data, repo, channel } = await setUp();
    chats();
    await tellPullEvent(db, data, out, repo, eventsOf(repo.id, "LGTM", 1), night);
    expect(await data.count("notifyHeld")).toBe(1);
    const res = await call(`/api/notifications/channels/${channel.id}`, {
      method: "DELETE",
      auth: me.auth,
    });
    expect(res.status).toBe(200);
    expect(await data.count("notifyHeld")).toBe(0);
  });
});

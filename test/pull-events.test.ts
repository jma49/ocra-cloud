import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellChecksFailed } from "../src/notify/pull-events.js";
import {
  githubPullEvents,
  gitlabPullEvents,
  tellGithubHook,
  tellGitlabHook,
} from "../src/notify/pull-hooks.js";
import type { NotifyEvent } from "../src/shared/index.js";
import { upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

// A user hears about their own pull requests' events: known by the
// platform's id of their user, never a login, only in the channels that
// subscribed to the event, and once however often the webhook arrives.

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

/** A signed-in account (GitHub user ME), its enrolled repository and a channel subscribed to events. */
async function setUp(events: NotifyEvent[], when = "blocking") {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  const repo = (await data.get("reviewRepos", repoId)) as NonNullable<
    Awaited<ReturnType<typeof data.get<"reviewRepos">>>
  >;
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", url: SLACK, name: "team", when, events },
  });
  const { channel } = (await added.json()) as { channel: { id: string; events: string[] } };
  return { me, data, repo, channel };
}

const user = (id: number, login: string) => ({ id, login, type: "User" });

const review = (state: string, reviewer = user(OTHER, "hubot"), body = "Looks good") => ({
  action: "submitted",
  review: { id: 900, user: reviewer, state, body },
  pull_request: { number: 5, title: "Add <!channel> cache", user: user(ME, "mona") },
  repository: { id: 11 },
});

describe("a GitHub delivery's events", () => {
  it("names who the event concerns and who did it, by id", () => {
    const [e] = githubPullEvents("pull_request_review", review("changes_requested"), "r");
    expect(e).toMatchObject({
      kind: "pull_reviewed",
      key: "github:review:r:900",
      concerns: String(ME),
      by: String(OTHER),
      what: "hubot requested changes on your pull request",
    });
    expect(e?.more?.[0]).not.toContain("<!channel>");
  });

  it("leaves out a bot's review and a thread reply with no text", () => {
    const bot = { id: 3, login: "ocra[bot]", type: "Bot" };
    expect(githubPullEvents("pull_request_review", review("approved", bot), "r")).toEqual([]);
    expect(
      githubPullEvents("pull_request_review", review("commented", user(OTHER, "x"), ""), "r"),
    ).toEqual([]);
  });

  it("asks the reviewer requested, and tells the author of a merge", () => {
    const pull = { title: "T", user: user(ME, "mona"), updated_at: "2026-11-01T00:00:00Z" };
    const [asked] = githubPullEvents(
      "pull_request",
      {
        action: "review_requested",
        number: 5,
        pull_request: pull,
        requested_reviewer: user(OTHER, "hubot"),
        sender: user(ME, "mona"),
        repository: { id: 11 },
      },
      "r",
    );
    expect(asked).toMatchObject({ kind: "review_requested", concerns: String(OTHER) });
    const [closed] = githubPullEvents(
      "pull_request",
      {
        action: "closed",
        number: 5,
        pull_request: { ...pull, merged: true, closed_at: "2026-11-02T00:00:00Z" },
        sender: user(OTHER, "hubot"),
        repository: { id: 11 },
      },
      "r",
    );
    expect(closed).toMatchObject({
      kind: "pull_closed",
      concerns: String(ME),
      what: "Your pull request was merged by hubot",
    });
  });
});

describe("a GitLab hook's events", () => {
  it("asks each reviewer added, and tells the author of an approval", () => {
    const events = gitlabPullEvents(
      {
        object_attributes: {
          iid: 3,
          action: "approved",
          title: "T",
          author_id: ME,
          updated_at: "2026-11-01 00:00:00 UTC",
        },
        user: { id: OTHER, username: "hubot" },
        changes: {
          reviewers: {
            previous: [{ id: 1, username: "a" }],
            current: [
              { id: 1, username: "a" },
              { id: ME, username: "mona" },
            ],
          },
        },
      },
      "r",
    );
    expect(events.map((e) => [e.kind, e.concerns])).toEqual([
      ["review_requested", String(ME)],
      ["pull_reviewed", String(ME)],
    ]);
  });
});

describe("telling the account", () => {
  it("tells a subscribed channel once, however often the webhook arrives", async () => {
    const posted = chats();
    const { channel } = await setUp(["pull_reviewed"]);
    expect(channel.events).toEqual(["pull_reviewed"]);
    const body = review("approved");
    expect(await tellGithubHook(db, out(), "pull_request_review", body)).toBe(1);
    expect(await tellGithubHook(db, out(), "pull_request_review", body)).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("hubot approved your pull request");
    expect(posted[0]).toContain("<https://console.test/pull/github/octo%2Fapi/5|octo/api#5>");
  });

  it("tells nobody of another user's pull request, or of what the user did", async () => {
    const posted = chats();
    await setUp(["pull_reviewed", "review_requested"]);
    const theirs = review("approved");
    theirs.pull_request.user = user(OTHER + 1, "mona");
    expect(await tellGithubHook(db, out(), "pull_request_review", theirs)).toBe(0);
    const asked = {
      action: "review_requested",
      number: 5,
      pull_request: { title: "T", user: user(OTHER, "x"), updated_at: "2026-11-01T00:00:00Z" },
      requested_reviewer: user(ME, "mona"),
      sender: user(ME, "mona"),
      repository: { id: 11 },
    };
    expect(await tellGithubHook(db, out(), "pull_request", asked)).toBe(0);
    expect(posted).toEqual([]);
  });

  it("matches by id, not a login another user may now have", async () => {
    const posted = chats();
    await setUp(["pull_reviewed"]);
    const renamed = review("approved");
    renamed.pull_request.user = user(OTHER + 1, "mona");
    expect(await tellGithubHook(db, out(), "pull_request_review", renamed)).toBe(0);
    expect(posted).toEqual([]);
  });

  it("tells only the channels that subscribed to the event", async () => {
    const posted = chats();
    await setUp(["pull_closed"]);
    expect(await tellGithubHook(db, out(), "pull_request_review", review("approved"))).toBe(0);
    expect(posted).toEqual([]);
  });

  it("knows a GitLab user only by the account's link, and not at all without one", async () => {
    const posted = chats();
    const { data, repo } = await setUp(["pull_closed"]);
    const gitlab = { ...repo, platform: "gitlab" as const, host: "gitlab.test" };
    const merged = {
      object_attributes: { iid: 3, action: "merge", title: "T", author_id: ME, updated_at: "u" },
      user: { id: OTHER, username: "hubot" },
    };
    expect(await tellGitlabHook(db, out(), gitlab, merged)).toBe(0);
    await data.insert("platformLinks", {
      platform: "gitlab",
      host: "gitlab.test",
      wrappedKey: "w",
      ciphertext: "c",
      userId: String(ME),
    });
    expect(await tellGitlabHook(db, out(), gitlab, merged)).toBe(1);
    expect(posted[0]).toContain("Your merge request was merged by hubot");
  });

  it("tells the author of failed checks once per head", async () => {
    const posted = chats();
    const { data, repo } = await setUp(["checks_failed"]);
    await data.pullFlows.record({
      reviewRepoId: repo.id,
      number: 5,
      title: "T",
      author: "mona",
      authorId: String(ME),
      draft: false,
      size: null,
      seenAt: new Date(),
    });
    const pull = { number: 5, head: "a".repeat(40), summary: "1 blocking check failed" };
    expect(await tellChecksFailed(db, data, out(), repo, pull)).toHaveLength(1);
    expect(await tellChecksFailed(db, data, out(), repo, pull)).toEqual([]);
    expect(posted[0]).toContain("Pre-merge checks failed on your pull request");
  });
});

describe("ocra's review of the user's pull request", () => {
  it("tells its author once, in place of the review's announcement there", async () => {
    const posted = chats();
    const { me, data, repo } = await setUp(["review_blocking"]);
    await call("/api/notifications/channels", {
      method: "POST",
      auth: me.auth,
      json: { kind: "slack", url: SLACK, name: "all", when: "every" },
    });
    await data.pullFlows.record({
      reviewRepoId: repo.id,
      number: 5,
      title: "T",
      author: null,
      authorId: String(ME),
      draft: false,
      size: null,
      seenAt: new Date(),
    });
    const cli = await signInCli(ME, "mona");
    const res = await call("/api/reviews", {
      method: "POST",
      auth: cli.auth,
      json: {
        ...upload("20261004T060000Z-0a0b0c", []),
        source: "github",
        pullRequest: {
          repository: "https://github.com/octo/api",
          number: 5,
          headSha: "9".repeat(40),
        },
      },
    });
    expect(res.status).toBe(200);
    expect(posted).toHaveLength(2);
    expect(posted.filter((t) => t.includes("ocra found 1 critical finding"))).toHaveLength(1);
    expect(posted.filter((t) => t.startsWith("ocra reviewed"))).toHaveLength(1);
  });
});

describe("a channel's events", () => {
  it("are none unless set, and are changed with PATCH", async () => {
    const me = await signIn(ME, "mona");
    const added = await call("/api/notifications/channels", {
      method: "POST",
      auth: me.auth,
      json: { kind: "slack", url: SLACK, name: "team", when: "blocking" },
    });
    const { channel } = (await added.json()) as { channel: { id: string; events: string[] } };
    expect(channel.events).toEqual([]);
    const changed = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: me.auth,
      json: { events: ["pull_closed", "review_requested", "pull_closed"] },
    });
    expect(((await changed.json()) as { channel: { events: string[] } }).channel.events).toEqual([
      "review_requested",
      "pull_closed",
    ]);
    const refused = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: me.auth,
      json: { events: ["everything"] },
    });
    expect(refused.status).toBe(400);
  });
});

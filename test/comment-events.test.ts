import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { githubCommentEvents, gitlabCommentEvents } from "../src/notify/comment-hooks.js";
import { excerptOf, MAX_COMMENT, mentionsOf } from "../src/notify/mentions.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellPullEvent } from "../src/notify/pull-events.js";
import { tellGithubHook, tellGitlabNote } from "../src/notify/pull-hooks.js";
import type { NotifyEvent } from "../src/shared/index.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// The pull request conversation tells the user of comments on what they
// wrote and of mentions of their login: never of their own comment or a
// bot's, once per comment, and only in the channels that chose it.

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

async function setUp(events: NotifyEvent[], extra: { quietHours?: unknown } = {}, githubId = ME) {
  const me = await signIn(githubId, "mona");
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
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events, ...extra },
  });
  expect(added.ok).toBe(true);
  return { me, data, repo };
}

const user = (id: number, login: string, type = "User") => ({ id, login, type });

const issueComment = (body: string, by = user(OTHER, "hubot"), id = 500, author = ME) => ({
  action: "created",
  issue: { number: 5, title: "Add <!channel> cache", user: user(author, "x"), pull_request: {} },
  comment: { id, body, user: by },
  repository: { id: 11 },
});

describe("reading mentions", () => {
  it("finds a login at a word boundary, in any case, each once", () => {
    expect(mentionsOf("cc @Mona, and @mona again; (@hubot)")).toEqual(["mona", "hubot"]);
    expect(mentionsOf("@mona.")).toEqual(["mona"]);
  });

  it("ignores addresses, longer names, teams, code and quotes", () => {
    expect(mentionsOf("mail mona@example.com")).toEqual([]);
    expect(mentionsOf("@mona-team and @org/mona")).toEqual(["mona-team"]);
    expect(mentionsOf("run `@mona` or ``a ` @mona``")).toEqual([]);
    expect(mentionsOf("```\n@mona\n```\n~~~js\n@mona\n~~~")).toEqual([]);
    expect(mentionsOf("> @mona said\n  > @mona")).toEqual([]);
    expect(mentionsOf("```\nunclosed\n@mona")).toEqual([]);
    expect(mentionsOf("a ` lone backtick @mona")).toEqual(["mona"]);
  });

  it("reads only the start of a long comment", () => {
    expect(mentionsOf(`${"x ".repeat(MAX_COMMENT)} @mona`)).toEqual([]);
    expect(mentionsOf("`".repeat(MAX_COMMENT * 2))).toEqual([]);
  });

  it("quotes a short excerpt with no markup or mention a chat would read", () => {
    const e = excerptOf(`<!channel> **look** @here [x](http://e) \`code\` ${"long ".repeat(50)}`);
    expect(e).not.toMatch(/[<>*@[\]()`]/);
    expect([...e].length).toBeLessThanOrEqual(100);
    expect(excerptOf("```\nsecret code\n```")).toBe("");
  });
});

describe("a GitHub comment's events", () => {
  it("tells the author of a comment, and whoever it mentions, under one key", () => {
    const events = githubCommentEvents("issue_comment", issueComment("@mona see this"), "r");
    expect(events.map((e) => [e.kind, e.key, e.concerns, e.mentions])).toEqual([
      ["mentioned", "github:comment:r:500", undefined, ["mona"]],
      ["pull_commented", "github:comment:r:500", String(ME), undefined],
    ]);
    expect(events[1]?.by).toBe(String(OTHER));
    expect(events[1]?.what).toBe("hubot commented on your pull request");
  });

  it("leaves out bots, ocra's own included", () => {
    const bot = user(3, "ocra[bot]", "Bot");
    expect(githubCommentEvents("issue_comment", issueComment("@mona", bot), "r")).toEqual([]);
    const token = user(4, "project_12_bot_abc");
    expect(githubCommentEvents("issue_comment", issueComment("@mona", token), "r")).toEqual([]);
  });

  it("keys a review's inline comments by the review, a mention by the comment", () => {
    const events = githubCommentEvents(
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 5, title: "T", user: user(ME, "mona") },
        comment: {
          id: 77,
          body: "@mona nit",
          user: user(OTHER, "hubot"),
          pull_request_review_id: 900,
        },
        repository: { id: 11 },
      },
      "r",
    );
    expect(events.map((e) => [e.kind, e.key])).toEqual([
      ["mentioned", "github:comment:r:77"],
      ["pull_commented", "github:review:r:900"],
    ]);
  });

  it("reads a review's body for mentions, and as a comment only when it commented", () => {
    const review = (state: string) => ({
      action: "submitted",
      pull_request: { number: 5, title: "T", user: user(ME, "mona") },
      review: { id: 900, user: user(OTHER, "hubot"), state, body: "thanks @mona" },
      repository: { id: 11 },
    });
    expect(
      githubCommentEvents("pull_request_review", review("approved"), "r").map((e) => e.kind),
    ).toEqual(["mentioned"]);
    expect(
      githubCommentEvents("pull_request_review", review("commented"), "r").map((e) => [
        e.kind,
        e.key,
      ]),
    ).toEqual([
      ["mentioned", "github:review:r:900"],
      ["pull_commented", "github:review:r:900"],
    ]);
  });
});

describe("a GitLab note's events", () => {
  const note = (body: string, by = { id: OTHER, username: "hubot" }, system = false) => ({
    object_kind: "note",
    user: by,
    object_attributes: { id: 31, note: body, noteable_type: "MergeRequest", system },
    merge_request: { iid: 3, title: "T", author_id: ME },
    project: { id: 9 },
  });

  it("tells the author and whoever it mentions, under the note's key", () => {
    expect(gitlabCommentEvents(note("ping @Mona"), "r").map((e) => [e.kind, e.key])).toEqual([
      ["mentioned", "gitlab:note:r:31"],
      ["pull_commented", "gitlab:note:r:31"],
    ]);
  });

  it("leaves out bots, system notes and other notes", () => {
    expect(gitlabCommentEvents(note("@mona", { id: 1, username: "project_9_bot_x" }), "r")).toEqual(
      [],
    );
    expect(
      gitlabCommentEvents(note("@mona", { id: 1, username: "x", bot: true } as never), "r"),
    ).toEqual([]);
    expect(gitlabCommentEvents(note("@mona", undefined, true), "r")).toEqual([]);
    const issue = note("@mona");
    issue.object_attributes.noteable_type = "Issue";
    expect(gitlabCommentEvents(issue, "r")).toEqual([]);
  });
});

describe("telling the account of the conversation", () => {
  it("tells a channel once per comment, a mention in place of the comment notice", async () => {
    const posted = chats();
    await setUp(["pull_commented", "mentioned"]);
    const body = issueComment("@mona can you look? <!channel>");
    expect(await tellGithubHook(db, "github.com", out(), "issue_comment", body)).toBe(1);
    expect(await tellGithubHook(db, "github.com", out(), "issue_comment", body)).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("hubot mentioned you");
    expect(posted[0]).toContain("can you look");
    expect(posted[0]).not.toContain("<!channel>");
    expect(posted[0]).not.toContain("@mona");
  });

  it("tells the author of a comment without a mention", async () => {
    const posted = chats();
    await setUp(["pull_commented"]);
    expect(
      await tellGithubHook(db, "github.com", out(), "issue_comment", issueComment("LGTM")),
    ).toBe(1);
    expect(posted[0]).toContain("hubot commented on your pull request");
  });

  it("tells nobody of their own comment, a bot's, or a channel that did not choose it", async () => {
    const posted = chats();
    await setUp(["mentioned"]);
    expect(
      await tellGithubHook(
        db,
        "github.com",
        out(),
        "issue_comment",
        issueComment("note to self @mona", user(ME, "mona")),
      ),
    ).toBe(0);
    expect(
      await tellGithubHook(
        db,
        "github.com",
        out(),
        "issue_comment",
        issueComment("@mona", user(3, "ocra[bot]", "Bot")),
      ),
    ).toBe(0);
    expect(
      await tellGithubHook(db, "github.com", out(), "issue_comment", issueComment("LGTM")),
    ).toBe(0);
    expect(
      await tellGithubHook(
        db,
        "github.com",
        out(),
        "issue_comment",
        issueComment("@monalisa hi", undefined, 501),
      ),
    ).toBe(0);
    expect(posted).toEqual([]);
  });

  it("holds back comment notices in a channel's quiet hours, once", async () => {
    const posted = chats();
    const { data, repo } = await setUp(["pull_commented"], { quietHours: { start: 22, end: 7 } });
    const [comment] = githubCommentEvents("issue_comment", issueComment("LGTM"), repo.id);
    if (!comment) throw new Error("no event");
    const night = new Date("2026-11-02T23:30:00Z");
    expect(await tellPullEvent(db, data, out(), repo, [comment], night)).toEqual([]);
    const day = new Date("2026-11-03T12:00:00Z");
    expect(await tellPullEvent(db, data, out(), repo, [comment], day)).toEqual([]);
    expect(posted).toEqual([]);
    expect(await data.count("notifyHeld")).toBe(1);
  });

  it("tells only the account that enrolled the repository", async () => {
    const posted = chats();
    await setUp(["mentioned"]);
    const other = await signIn(OTHER + 100, "hubot2");
    await call("/api/notifications/channels", {
      method: "POST",
      auth: other.auth,
      json: { kind: "slack", url: SLACK, name: "theirs", when: "blocking", events: ["mentioned"] },
    });
    expect(
      await tellGithubHook(db, "github.com", out(), "issue_comment", issueComment("@hubot2 @mona")),
    ).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it("knows a GitLab user's login only by the account's link", async () => {
    const posted = chats();
    const { data, repo } = await setUp(["mentioned"]);
    const gitlab = { ...repo, platform: "gitlab" as const, host: "gitlab.test" };
    const body = {
      object_kind: "note",
      user: { id: OTHER, username: "hubot" },
      object_attributes: { id: 31, note: "@lab-mona please", noteable_type: "MergeRequest" },
      merge_request: { iid: 3, title: "T", author_id: OTHER },
      project: { id: 9 },
    };
    await data.insert("platformLinks", {
      platform: "gitlab",
      host: "gitlab.test",
      wrappedKey: "w",
      ciphertext: "c",
      userId: String(ME),
    });
    expect(await tellGitlabNote(db, out(), gitlab, body)).toBe(0);
    await data.removeWhere("platformLinks", { platform: "gitlab", host: "gitlab.test" });
    await data.insert("platformLinks", {
      platform: "gitlab",
      host: "gitlab.test",
      wrappedKey: "w",
      ciphertext: "c",
      userId: String(ME),
      login: "Lab-Mona",
    });
    expect(await tellGitlabNote(db, out(), gitlab, body)).toBe(1);
    expect(posted[0]).toContain("hubot mentioned you");
  });
});

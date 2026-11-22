import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathReader } from "../src/auto-review/paths.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { gitlabStartOf } from "../src/notify/gitlab-starts.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellGitlabNote } from "../src/notify/pull-hooks.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// A GitLab diff or discussion note of a discussion not on record has its
// first note read once from the discussions API, as the bot or the link: that
// note is kept as the start, and the hook's note, when it is a reply, tells
// the starter. A refusal, a timeout or no token keeps nothing.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const LAB = "https://gitlab.test";
const ME = 42;
const OTHER = 7;
const D1 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const out = (): Outbox => ({
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
});

type Answer = Response | "timeout";

/** GitLab answers `lab()` to each discussion read; Slack takes every post. */
function platform(lab: () => Answer) {
  const asked: string[] = [];
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith(LAB)) {
      asked.push(`${req.headers.get("authorization")} ${req.url}`);
      const answer = lab();
      if (answer !== "timeout") return answer;
      return new Promise((_, reject) =>
        req.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
      );
    }
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return { asked, posted };
}

const discussion = (...notes: { id: number; by: number; login: string; system?: boolean }[]) =>
  Response.json({
    id: D1,
    notes: notes.map((n) => ({
      id: n.id,
      body: "never kept",
      author: { id: n.by, username: n.login },
      created_at: "2026-11-02T09:00:00Z",
      system: n.system ?? false,
    })),
  });

const note = (id: number, by: { id: number; username: string }, type = "DiffNote") => ({
  object_kind: "note",
  user: by,
  object_attributes: {
    id,
    note: "please look at this",
    noteable_type: "MergeRequest",
    type,
    discussion_id: D1,
    created_at: "2026-11-02 10:00:00 UTC",
  },
  merge_request: { iid: 3, title: "T", author_id: 99 },
  project: { id: 9 },
});

async function setUp(token: string | null = "bot-token") {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events: ["thread_replied"] },
  });
  expect(added.ok).toBe(true);
  await data.insert("platformLinks", {
    platform: "gitlab",
    host: "gitlab.test",
    wrappedKey: "w",
    ciphertext: "c",
    userId: String(ME),
    login: "lab-mona",
  });
  const repoId = await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.test",
    platformRepoId: "9",
    fullName: "group/api",
  });
  const repo = await data.get("reviewRepos", repoId);
  if (!repo) throw new Error("not enrolled");
  const reader: PathReader = {
    db,
    bots: token ? { forRepo: async () => ({ token }) } : undefined,
    platforms: [{ kind: "gitlab", host: "gitlab.test", url: LAB } as CodePlatform],
    env: { MASTER_KEY: "", MASTER_KEY_PREVIOUS: "" } as PathReader["env"],
  };
  const tell = (body: unknown) =>
    tellGitlabNote(db, out(), repo, body, gitlabStartOf(reader, repo));
  return { data, tell };
}

describe("GitLab discussion starts looked up", () => {
  it("keeps the hook's note as the start when it is the discussion's first, in one call", async () => {
    const { data, tell } = await setUp();
    const { asked, posted } = platform(() => discussion({ id: 1, by: ME, login: "lab-mona" }));
    expect(await tell(note(1, { id: ME, username: "lab-mona" }))).toBe(0);
    expect(asked).toEqual([
      `Bearer bot-token ${LAB}/api/v4/projects/group%2Fapi/merge_requests/3/discussions/${D1}`,
    ]);
    const [start] = await data.list("reviewThreads");
    expect(start).toMatchObject({ threadKey: D1, starterId: String(ME), number: 3 });
    expect(start?.repliedAt).toBeNull();
    expect(posted).toEqual([]);
    expect(JSON.stringify(await data.list("reviewThreads"))).not.toContain("never kept");
  });

  it("keeps the first note's start and tells its starter of the hook's reply; later replies call nothing", async () => {
    const { data, tell } = await setUp();
    const { asked, posted } = platform(() =>
      discussion({ id: 1, by: ME, login: "lab-mona" }, { id: 2, by: OTHER, login: "hubot" }),
    );
    expect(await tell(note(2, { id: OTHER, username: "hubot" }, "DiscussionNote"))).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("hubot replied in your review thread");
    const [thread] = await data.list("reviewThreads");
    expect(thread).toMatchObject({ threadKey: D1, starterId: String(ME) });
    expect(thread?.repliedAt).not.toBeNull();
    expect(await tell(note(3, { id: 8, username: "ada" }))).toBe(1);
    expect(asked).toHaveLength(1);
    expect(await data.count("reviewThreads")).toBe(1);
  });

  it("keeps nothing for a discussion a bot started, and never looks up a bot's note", async () => {
    const { data, tell } = await setUp();
    const { asked, posted } = platform(() =>
      discussion({ id: 1, by: 5, login: "project_9_bot_x" }, { id: 2, by: OTHER, login: "hubot" }),
    );
    expect(await tell(note(2, { id: OTHER, username: "hubot" }))).toBe(0);
    expect(await tell(note(4, { id: 5, username: "group_1_bot_y" }))).toBe(0);
    expect(asked).toHaveLength(1);
    expect(posted).toEqual([]);
    expect(await data.count("reviewThreads")).toBe(0);
  });

  it("keeps nothing, and does not throw, when GitLab refuses, times out or no token is held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { data, tell } = await setUp();
      const refused = platform(() => new Response("{}", { status: 403 }));
      expect(await tell(note(2, { id: OTHER, username: "hubot" }))).toBe(0);
      expect(refused.asked).toHaveLength(1);
      vi.restoreAllMocks();
      const slow = platform(() => "timeout");
      const told = tell(note(2, { id: OTHER, username: "hubot" }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await told).toBe(0);
      expect(slow.asked).toHaveLength(1);
      expect(slow.posted).toEqual([]);
      expect(await data.count("reviewThreads")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls nothing without a token: the link holds none it can open", async () => {
    const { data, tell } = await setUp(null);
    const { asked } = platform(() => discussion({ id: 1, by: ME, login: "lab-mona" }));
    expect(await tell(note(2, { id: OTHER, username: "hubot" }))).toBe(0);
    expect(asked).toEqual([]);
    expect(await data.count("reviewThreads")).toBe(0);
  });

  it("keeps a looked-up start under the enrolling account only", async () => {
    const { data, tell } = await setUp();
    platform(() =>
      discussion({ id: 1, by: ME, login: "lab-mona" }, { id: 2, by: OTHER, login: "hubot" }),
    );
    await tell(note(2, { id: OTHER, username: "hubot" }));
    const other = await signIn(OTHER + 100, "someone");
    expect(await scoped(db, other.account.id).count("reviewThreads")).toBe(0);
    expect(await data.count("reviewThreads")).toBe(1);
  });
});

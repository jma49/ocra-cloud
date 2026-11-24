import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keepGitlabFindingThread,
  onceEach,
  recordGithubFindingThread,
} from "../src/auto-review/finding-threads.js";
import type { PathReader } from "../src/auto-review/paths.js";
import { scoped } from "../src/db/scoped.js";
import { gitlabFields } from "../src/inbound/fields.js";
import { gitlabStartOf } from "../src/notify/gitlab-starts.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { MAX_DISMISSAL_REASON_CHARS, type PlatformDismissal } from "../src/shared/index.js";
import { seed } from "./fix-fakes.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// What a person does on the platform to the thread of ocra's comment of a
// finding is kept with the finding: who resolved it or opened it again and
// when, and their newest reply as the reason, redacted and cut. Never a
// bot's, nor the comment's own author's; once however often it is delivered.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const ME = 42;
const BOT = 900;
const FP = "0123456789abcdef";
const MARKER = `<!-- ocra:finding ${FP} -->`;
const HUB = "https://github.com";
const LAB = "https://gitlab.test";
const D1 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const user = (id: number, login: string, type = "User") => ({ id, login, type });
const bot = user(BOT, "ocra[bot]", "Bot");
const rita = user(7, "rita");

type Comment = {
  id: number;
  body: string;
  user: ReturnType<typeof user>;
  at?: string;
  to?: number;
};

const comment = (c: Comment) => ({
  id: c.id,
  body: c.body,
  user: c.user,
  created_at: c.at ?? "2026-11-02T10:00:00Z",
  ...(c.to !== undefined ? { in_reply_to_id: c.to } : {}),
});

const commented = (c: Comment, number = 7) => ({
  action: "created",
  pull_request: { number, title: "T" },
  comment: comment(c),
  repository: { id: 11 },
});

const changed = (
  action: "resolved" | "unresolved",
  by: ReturnType<typeof user>,
  comments: Comment[],
  at = "2026-11-02T12:00:00Z",
) => ({
  action,
  pull_request: { number: 7, updated_at: at },
  thread: { node_id: "T1", comments: comments.map(comment) },
  sender: by,
  repository: { id: 11 },
});

const start: Comment = { id: 100, body: `${MARKER}\n**Bug.** The lock is taken twice.`, user: bot };
const reply = (id: number, body: string, by = rita, at = "2026-11-02T11:00:00Z"): Comment => ({
  id,
  body,
  user: by,
  at,
  to: 100,
});

async function enrolled(platform: "github" | "gitlab" = "github") {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform,
    host: platform === "github" ? "github.com" : "gitlab.test",
    platformRepoId: platform === "github" ? "11" : "9",
    fullName: platform === "github" ? "Octo/API" : "group/api",
  });
  const repo = await data.get("reviewRepos", repoId);
  if (!repo) throw new Error("not enrolled");
  return { me, data, repo };
}

const github = (event: string, body: unknown) =>
  recordGithubFindingThread(db, "github.com", HUB, event, body);
const onComment = (c: Comment) => github("pull_request_review_comment", commented(c));

async function dismissalOf(auth: Record<string, string>, reviewId: string) {
  const res = await call(`/api/reviews/${reviewId}`, { auth });
  const body = (await res.json()) as {
    findings: { fingerprint: string; platformDismissal: PlatformDismissal | null }[];
  };
  return body.findings.find((f) => f.fingerprint === FP)?.platformDismissal;
}

describe("GitHub finding threads", () => {
  it("keeps who resolved the thread of ocra's comment, and their reply as the reason", async () => {
    const { me, data } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    await onComment(start);
    expect(await data.list("findingThreads")).toMatchObject([
      { number: 7, threadKey: "100", fingerprint: FP, starterId: String(BOT), state: null },
    ]);
    expect(await dismissalOf(me.auth, reviewId)).toBeNull();
    await onComment(reply(101, "  Not applicable: the lock is reentrant.  "));
    expect(await dismissalOf(me.auth, reviewId)).toEqual({
      state: null,
      by: null,
      at: null,
      reason: "Not applicable: the lock is reentrant.",
      reasonBy: "rita",
      reasonAt: "2026-11-02T11:00:00.000Z",
      redacted: false,
      truncated: false,
    });
    await github("pull_request_review_thread", changed("resolved", rita, [start]));
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "resolved",
      by: "rita",
      at: "2026-11-02T12:00:00.000Z",
      reason: "Not applicable: the lock is reentrant.",
    });
    await github(
      "pull_request_review_thread",
      changed("unresolved", user(8, "sam"), [start], "2026-11-02T13:00:00Z"),
    );
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "unresolved",
      by: "sam",
      at: "2026-11-02T13:00:00.000Z",
      reasonBy: "rita",
    });
  });

  it("puts a thread whose start it never saw on record from its resolution's comments", async () => {
    const { me, data } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    const thread = [
      start,
      reply(101, "an older reply", rita, "2026-11-02T10:30:00Z"),
      reply(102, "Wrong: this path never runs twice."),
      reply(103, "I looked again and agree.", bot, "2026-11-02T11:30:00Z"),
    ];
    await github("pull_request_review_thread", changed("resolved", rita, thread));
    expect(await data.count("findingThreads")).toBe(1);
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "resolved",
      by: "rita",
      reason: "Wrong: this path never runs twice.",
      reasonBy: "rita",
    });
  });

  it("changes nothing when a delivery comes again or late", async () => {
    const { me, data } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    await onComment(start);
    await onComment(reply(102, "the newer reply", rita, "2026-11-02T11:00:00Z"));
    await onComment(reply(101, "an older reply, late", rita, "2026-11-02T10:30:00Z"));
    await onComment(reply(102, "the newer reply", rita, "2026-11-02T11:00:00Z"));
    const resolved = changed("resolved", rita, [start], "2026-11-02T12:00:00Z");
    const reopened = changed("unresolved", rita, [start], "2026-11-02T13:00:00Z");
    await github("pull_request_review_thread", resolved);
    await github("pull_request_review_thread", reopened);
    const [before] = await data.list("findingThreads");
    await github("pull_request_review_thread", resolved);
    await onComment(start);
    expect(await data.list("findingThreads")).toEqual([{ ...before, seenAt: expect.any(Date) }]);
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "unresolved",
      reason: "the newer reply",
    });
  });

  it("never takes a bot's or the comment's own author's reply or resolution as a person's", async () => {
    const { me, data } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    // ocra posting as a person's token: its own comment, then its own answer and resolution.
    const own = user(55, "ocra-service");
    await onComment({ ...start, user: own });
    await onComment(reply(101, "My answer.", own));
    await onComment(reply(102, "A bot's reply.", user(901, "other[bot]", "Bot")));
    await github("pull_request_review_thread", changed("resolved", own, [{ ...start, user: own }]));
    await github("pull_request_review_thread", changed("resolved", bot, [{ ...start, user: own }]));
    expect(await dismissalOf(me.auth, reviewId)).toBeNull();
    expect(await data.list("findingThreads")).toMatchObject([{ state: null, reason: null }]);
  });

  it("keeps nothing of a thread that does not start with ocra's marker, nor of a repository not enrolled", async () => {
    const { data } = await enrolled();
    await onComment({ id: 100, body: "A person's comment.", user: rita });
    await onComment(reply(101, `> ${MARKER}\nquoting it`));
    await onComment({ id: 200, body: `See ${MARKER} above.`, user: rita });
    await github("pull_request_review_comment", {
      ...commented(start),
      repository: { id: 12 },
    });
    expect(await data.count("findingThreads")).toBe(0);
  });

  it("redacts and cuts the reason, and keeps no text for an account that keeps no such finding", async () => {
    const { me, data } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    await onComment(start);
    // The same finding's comment on a pull request with no stored finding.
    await github("pull_request_review_comment", commented({ ...start, id: 300 }, 8));
    await github("pull_request_review_comment", commented({ ...reply(301, "why"), to: 300 }, 8));
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await onComment(reply(101, `token ${secret} ${"x".repeat(MAX_DISMISSAL_REASON_CHARS)}`));
    const view = await dismissalOf(me.auth, reviewId);
    expect(view).toMatchObject({ redacted: true, truncated: true });
    expect(view?.reason).not.toContain(secret);
    expect(view?.reason?.length).toBeLessThanOrEqual(MAX_DISMISSAL_REASON_CHARS);
    const unkept = (await data.list("findingThreads")).find((t) => t.number === 8);
    expect(unkept).toMatchObject({ threadKey: "300", reason: null, reasonBy: null });
  });

  it("drops the replies' text when the account deletes its findings", async () => {
    const { me, data } = await enrolled();
    await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    await onComment(start);
    await onComment(reply(101, "Not applicable."));
    await github("pull_request_review_thread", changed("resolved", rita, [start]));
    const res = await call("/api/account/sharing", {
      method: "PUT",
      auth: me.auth,
      json: { enabled: false, deleteExisting: true },
    });
    expect(await res.json()).toMatchObject({ deleted: 1 });
    expect(await data.list("findingThreads")).toMatchObject([
      { state: "resolved", stateBy: "rita", reason: null, reasonBy: null, reasonAt: null },
    ]);
  });

  it("shows the thread acted on last when a finding was commented twice, and another account's nothing", async () => {
    const { me } = await enrolled();
    const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    await onComment(start);
    await onComment({ ...start, id: 400 });
    await onComment(reply(101, "first thread", rita, "2026-11-02T11:00:00Z"));
    await onComment({ ...reply(401, "second thread", rita, "2026-11-02T11:30:00Z"), to: 400 });
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({ reason: "second thread" });
    const other = await signIn(43, "nat");
    expect(await scoped(db, other.account.id).count("findingThreads")).toBe(0);
  });
});

describe("learning from a finding's thread", () => {
  const queued = async (data: Awaited<ReturnType<typeof enrolled>>["data"]) =>
    (await data.list("learnJobs")).map((j) => [j.number, j.state]);

  it("queues the pull request when a person answers or resolves the thread, never for ocra's own comment", async () => {
    const { data } = await enrolled();
    await onComment(start);
    expect(await queued(data)).toEqual([]);
    await onComment(reply(101, "Won't fix: the lock is reentrant."));
    expect(await queued(data)).toEqual([[7, "queued"]]);
    await github("pull_request_review_thread", changed("resolved", rita, [start]));
    expect(await queued(data)).toEqual([[7, "queued"]]);
    const [job] = await data.list("learnJobs");
    expect(job?.notBefore?.getTime()).toBeGreaterThan(Date.now());
  });

  it("queues nothing for a reply in someone else's thread, a reopened thread, or a repository that switched it off", async () => {
    const { data, repo } = await enrolled();
    await onComment({ id: 300, body: "Why a lock here?", user: rita });
    await onComment({ id: 301, body: "Because.", user: user(8, "sam"), to: 300 });
    await github("pull_request_review_thread", changed("unresolved", rita, [start]));
    expect(await queued(data)).toEqual([]);
    await data.update("reviewRepos", repo.id, { learn: "off" });
    await onComment(reply(101, "Won't fix: the lock is reentrant."));
    await github("pull_request_review_thread", changed("resolved", rita, [start]));
    expect(await queued(data)).toEqual([]);
  });
});

describe("GitLab finding threads", () => {
  type Note = { id: number; by: { id: number; username: string; bot?: boolean }; note: string };

  const hook = (n: Note, at = "2026-11-02 11:00:00 UTC") =>
    // As the delivery's work keeps it (src/inbound/fields.ts).
    gitlabFields({
      object_kind: "note",
      user: n.by,
      object_attributes: {
        id: n.id,
        note: n.note,
        noteable_type: "MergeRequest",
        type: "DiffNote",
        discussion_id: D1,
        created_at: at,
        url: "https://gitlab.test/never-kept",
      },
      merge_request: { iid: 3, title: "T", author_id: 99 },
      project: { id: 9 },
    });

  const ocra = { id: BOT, username: "project_9_bot_abc", bot: true };
  const lena = { id: 7, username: "lena" };

  type Resolved = { by?: { id: number; username: string }; at?: string } | false;

  /** GitLab answers the discussion, resolved or not, to each read. */
  function gitlab(resolved: () => Resolved, first = `${MARKER}\nA bug.`) {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      asked.push(req.url);
      const r = resolved();
      return Response.json({
        id: D1,
        notes: [
          {
            id: 1,
            body: first,
            author: { id: ocra.id, username: ocra.username },
            created_at: "2026-11-02T09:00:00Z",
            system: false,
            resolvable: true,
            resolved: r !== false,
            resolved_by: r ? (r.by ?? null) : null,
            resolved_at: r ? (r.at ?? null) : null,
          },
        ],
      });
    });
    return asked;
  }

  async function setUp() {
    const { me, data, repo } = await enrolled("gitlab");
    const { reviewId } = await seed("https://gitlab.test/group/api", 3, { fingerprint: FP });
    const reader: PathReader = {
      db,
      bots: { forRepo: async () => ({ token: "bot-token" }) },
      platforms: [{ kind: "gitlab", host: "gitlab.test", url: LAB } as CodePlatform],
      env: { MASTER_KEY: "", MASTER_KEY_PREVIOUS: "" } as PathReader["env"],
    };
    const keep = (body: unknown, startOf = onceEach(gitlabStartOf(reader, repo))) =>
      keepGitlabFindingThread(db, repo, LAB, body, startOf);
    return { me, data, reviewId, keep, startOf: () => onceEach(gitlabStartOf(reader, repo)) };
  }

  it("keeps ocra's note as the start, a person's reply as the reason, and the resolution it reads", async () => {
    const { me, data, reviewId, keep } = await setUp();
    let resolved: Resolved = false;
    const asked = gitlab(() => resolved);
    await keep(hook({ id: 1, by: ocra, note: `${MARKER}\nA bug.` }));
    expect(asked).toEqual([]);
    expect(await data.list("findingThreads")).toMatchObject([
      { repository: "https://gitlab.test/group/api", number: 3, threadKey: D1, fingerprint: FP },
    ]);
    expect(await data.count("learnJobs")).toBe(0);
    await keep(hook({ id: 2, by: lena, note: "Not applicable here." }));
    expect(asked).toHaveLength(1);
    expect(await data.list("learnJobs")).toMatchObject([{ number: 3, state: "queued" }]);
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: null,
      reason: "Not applicable here.",
      reasonBy: "lena",
    });
    resolved = { by: lena, at: "2026-11-02T11:00:05Z" };
    await keep(hook({ id: 3, by: lena, note: "Resolving." }, "2026-11-02 11:00:04 UTC"));
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "resolved",
      by: "lena",
      at: "2026-11-02T11:00:05.000Z",
      reason: "Resolving.",
    });
    const status = async () => (await data.list("findings")).map((f) => f.status);
    expect(await status()).toEqual(["addressed"]);
    resolved = false;
    await keep(
      hook({ id: 4, by: lena, note: "Reopened: still wrong." }, "2026-11-02 12:00:00 UTC"),
    );
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "unresolved",
      by: null,
      at: "2026-11-02T12:00:00.000Z",
      reason: "Reopened: still wrong.",
    });
    expect(await status()).toEqual(["open"]);
  });

  it("makes no call of its own for a discussion not on record, and takes one already answered", async () => {
    const { me, data, reviewId, keep, startOf } = await setUp();
    const asked = gitlab(() => ({ by: lena, at: "2026-11-02T11:00:05Z" }));
    await keep(hook({ id: 2, by: lena, note: "Declined: by design." }));
    expect(asked).toEqual([]);
    expect(await data.count("findingThreads")).toBe(0);
    const once = startOf();
    await once(3, D1);
    await keep(hook({ id: 2, by: lena, note: "Declined: by design." }), once);
    expect(asked).toHaveLength(1);
    expect(await dismissalOf(me.auth, reviewId)).toMatchObject({
      state: "resolved",
      by: "lena",
      reason: "Declined: by design.",
    });
  });

  it("keeps nothing of a bot's note, or of a discussion that is not a finding's", async () => {
    const { data, keep, startOf } = await setUp();
    const asked = gitlab(() => false, "A person's comment.");
    await keep(hook({ id: 1, by: ocra, note: `${MARKER}\nA bug.` }));
    await keep(hook({ id: 2, by: ocra, note: "My answer." }));
    expect(await data.list("findingThreads")).toMatchObject([{ reason: null, state: null }]);
    await data.removeWhere("findingThreads", { threadKey: D1 });
    const once = startOf();
    await once(3, D1);
    await keep(hook({ id: 3, by: lena, note: "A reply." }), once);
    expect(await data.count("findingThreads")).toBe(0);
    expect(asked).toHaveLength(1);
  });
});

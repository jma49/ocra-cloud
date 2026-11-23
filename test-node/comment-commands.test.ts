import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, C2, GITLAB, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// `@ocra <command>` on an enrolled repository's pull request: run once per
// comment, only for a person the platform says may push, answered as the
// bot; any other mention is still a question.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-commands-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const GH = "https://api.github.com/repos/Octo/API";
const MR = `${GITLAB}/api/v4/projects/group%2Fapi/merge_requests/3`;
const MARKER = `<!-- ocra:finding ${"a".repeat(16)} -->`;

type Sent = { method: string; url: string; body: unknown };
let s: Server;
let sent: Sent[];
const writes = () => sent.filter((w) => w.method !== "GET");
const posted = () => writes().map((w) => (w.body as { body?: string }).body);

beforeEach(async () => {
  s = await graphServer(dir, `commands-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    tokens: { forRepo: async () => ({ token: "bot-token" }) },
    workers: 0,
  });
  sent = [];
  const fake = repoFake({ [C1]: {} }, C1, {
    7: { base: C1, head: C2, files: [] },
    3: { base: C1, head: C2, files: [] },
  });
  const inner = fake.fetch.getMockImplementation();
  fake.fetch.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    const auth = req.headers.get("authorization") ?? "";
    // Only the bot's token reads access and writes; a person's would be the console's.
    const bot = auth.includes("bot-token");
    const permission = /collaborators\/([^/]+)\/permission$/.exec(url)?.[1];
    if (url.startsWith(GH) && permission) {
      const level = { alice: "write", root: "admin", bob: "read" }[permission];
      if (!bot) return new Response(null, { status: 403 });
      return level ? Response.json({ permission: level }) : new Response(null, { status: 404 });
    }
    const member = /projects\/group%2Fapi\/members\/all\/(\d+)$/.exec(url)?.[1];
    if (member) {
      const level = { "5": 30, "6": 20 }[member];
      return level ? Response.json({ access_level: level }) : new Response(null, { status: 404 });
    }
    if (req.method !== "GET") {
      sent.push({ method: req.method, url, body: await req.clone().json() });
      if (url.startsWith(`${MR}/discussions/`)) return Response.json({ notes: [] });
      return Response.json({ id: 1 }, { status: 201 });
    }
    if (url === MR) {
      return Response.json({ sha: C2, title: "t", diff_refs: { base_sha: C1, head_sha: C2 } });
    }
    if (url.startsWith(`${MR}/discussions?`)) {
      const note = (body: string, resolved: boolean) => ({
        id: 1,
        type: "DiffNote",
        body,
        system: false,
        resolvable: true,
        resolved,
        position: { head_sha: C2, new_path: "a.ts", old_path: "a.ts", new_line: 1, old_line: null },
      });
      return Response.json([
        { id: "open-finding", notes: [note(`${MARKER}\nA bug.`, false)] },
        { id: "done-finding", notes: [note(`${MARKER}\nFixed.`, true)] },
        { id: "a-person", notes: [note("Rename this?", false)] },
      ]);
    }
    if (!inner) throw new Error("no fake");
    return inner(input, init);
  });
});
afterEach(async () => {
  await s.host.idle();
  s.host.close();
});

const commands = () =>
  s.host.db.select().from(schema.pullCommands).orderBy(schema.pullCommands.createdAt);
const replies = () => s.host.db.select().from(schema.replyJobs);
const jobs = () => s.host.db.select().from(schema.reviewJobs);

async function fromGithub(event: string, json: Record<string, unknown>) {
  const body = JSON.stringify(json);
  const res = await s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
  const answer = (await res.json()) as { queued: number };
  await s.host.idle();
  return answer;
}

const repository = { id: 11, full_name: "Octo/API" };
let ids = 600;
const said = (body: string, login: string | undefined = "alice", id = ids++) => ({
  action: "created",
  comment: { id, body, user: { type: "User", ...(login ? { login } : {}) } },
  issue: { number: 7, pull_request: { url: "x" } },
  repository,
});
const pushed = () =>
  fromGithub("pull_request", {
    action: "synchronize",
    number: 7,
    pull_request: { head: { sha: C2 } },
    repository,
  });

describe("commands on GitHub", () => {
  let auth: Record<string, string>;
  let repoId: string;
  beforeEach(async () => {
    auth = (await s.signIn(1)).auth;
    const res = await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: auth,
      json: { platform: "github", fullName: "octo/api", automatic: true },
    });
    expect(res.status).toBe(200);
    repoId = ((await res.json()) as { repo: { id: string } }).repo.id;
  });

  const paused = () => s.host.db.select().from(schema.pausedPulls);
  const closed = (closedAt: Date) =>
    fromGithub("pull_request", {
      action: "closed",
      number: 7,
      pull_request: { title: "t", merged: true, merged_at: closedAt.toISOString() },
      repository,
    });

  it("ends the pause when the pull request closes, not one made after a reopen", async () => {
    await fromGithub("issue_comment", said("@ocra pause"));
    expect(await paused()).toHaveLength(1);
    await closed(new Date());
    expect(await paused()).toEqual([]);
    await fromGithub("issue_comment", said("@ocra pause"));
    // A close redelivered after the pull request was reopened and paused again.
    await closed(new Date(Date.now() - 60_000));
    expect(await paused()).toHaveLength(1);
  });

  it("lists the pull request's commands and pauses it from the console, never naming the comment", async () => {
    await fromGithub("issue_comment", said("@ocra help", "alice", 901));
    await fromGithub("issue_comment", said("@ocra pause", "bob", 902));
    const url = `/api/auto-review/repos/${repoId}/pulls/7`;
    const listed = async () => (await s.call(`${url}/commands`, { headers: auth })).json();
    expect(await listed()).toEqual({
      paused: false,
      commands: [
        expect.objectContaining({ command: "pause", outcome: "refused" }),
        {
          command: "help",
          outcome: "done",
          createdAt: expect.any(String),
          finishedAt: expect.any(String),
        },
      ],
    });
    const put = await s.call(`${url}/pause`, { method: "PUT", headers: auth });
    expect(await put.json()).toEqual({ paused: true });
    expect(await pushed()).toEqual({ queued: 0 });
    expect((await listed()) as { paused: boolean }).toMatchObject({ paused: true });
    const del = await s.call(`${url}/pause`, { method: "DELETE", headers: auth });
    expect(await del.json()).toEqual({ paused: false });
    expect(await pushed()).toEqual({ queued: 1 });
    const events = (await (await s.call("/api/audit", { headers: auth })).json()) as {
      events: { kind: string; detail: unknown }[];
    };
    expect(events.events.filter((e) => e.kind.startsWith("auto_review.pull_"))).toEqual([
      expect.objectContaining({ kind: "auto_review.pull_resumed", detail: { pull: "Octo/API#7" } }),
      expect.objectContaining({ kind: "auto_review.pull_paused", detail: { pull: "Octo/API#7" } }),
    ]);
  });

  it("answers not found for another account's repository or a number that is not one", async () => {
    const other = (await s.signIn(2)).auth;
    const base = `/api/auto-review/repos/${repoId}/pulls`;
    for (const [path, headers, method] of [
      [`${base}/7/commands`, other, "GET"],
      [`${base}/7/pause`, other, "PUT"],
      [`${base}/7/pause`, other, "DELETE"],
      [`${base}/0/commands`, auth, "GET"],
      [`${base}/x/pause`, auth, "PUT"],
    ] as const) {
      expect((await s.call(path, { method, headers })).status, path).toBe(404);
    }
    expect(await paused()).toEqual([]);
  });

  it("answers help once per comment, as the bot, and queues no question", async () => {
    const help = said("@ocra help", "alice", 501);
    expect(await fromGithub("issue_comment", help)).toEqual({ queued: 1 });
    expect(await fromGithub("issue_comment", help)).toEqual({ queued: 0 });
    expect(writes()).toEqual([
      {
        method: "POST",
        url: `${GH}/issues/7/comments`,
        body: { body: expect.stringContaining("`@ocra pause`") },
      },
    ]);
    expect((await commands()).map((c) => [c.commentId, c.command, c.outcome])).toEqual([
      ["501", "help", "done"],
    ]);
    expect(await replies()).toEqual([]);
  });

  it("queues a review of the platform's head", async () => {
    await fromGithub("issue_comment", said("@ocra review", "root"));
    expect((await jobs()).map((j) => [j.number, j.head, j.state])).toEqual([[7, C2, "queued"]]);
    expect(posted()).toEqual(["Queued a review of `2222222`."]);
  });

  it("pauses the pull request's automatic reviews until it is resumed", async () => {
    await fromGithub("issue_comment", said("@ocra pause"));
    expect(await pushed()).toEqual({ queued: 0 });
    await fromGithub("issue_comment", said("@ocra resume"));
    expect(await pushed()).toEqual({ queued: 1 });
    expect(posted()).toEqual([
      expect.stringMatching(/^Paused: /),
      "Resumed: ocra reviews this pull request again as it gains commits.",
    ]);
  });

  it("refuses, without a word, a person who may not push, or one it cannot name", async () => {
    await fromGithub("issue_comment", said("@ocra pause", "bob"));
    await fromGithub("issue_comment", said("@ocra pause", "mallory"));
    await fromGithub("issue_comment", said("@ocra pause", ""));
    expect((await commands()).map((c) => c.outcome)).toEqual(["refused", "refused", "refused"]);
    expect(writes()).toEqual([]);
    expect(await pushed()).toEqual({ queued: 1 });
  });

  it("runs a command from a review comment on a line, answered in the conversation", async () => {
    const inline = {
      action: "created",
      comment: { id: 801, body: "@ocra pause", user: { type: "User", login: "alice" } },
      pull_request: { number: 7 },
      repository,
    };
    expect(await fromGithub("pull_request_review_comment", inline)).toEqual({ queued: 1 });
    expect(writes().map((w) => w.url)).toEqual([`${GH}/issues/7/comments`]);
    expect(await pushed()).toEqual({ queued: 0 });
  });

  it("leaves anything else to the question path", async () => {
    await fromGithub("issue_comment", said("@ocra frobnicate", "alice", 701));
    await fromGithub("issue_comment", said("@ocra review this, is it safe?", "alice", 702));
    expect((await replies()).map((r) => r.commentId).sort()).toEqual(["701", "702"]);
    expect(await commands()).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("commands on GitLab", () => {
  let secret: string;
  beforeEach(async () => {
    const { auth } = await s.signIn(1);
    const res = await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: auth,
      json: { platform: "gitlab", fullName: "group/api" },
    });
    secret = ((await res.json()) as { webhook: { secret: string } }).webhook.secret;
    sent = [];
  });

  const note = async (body: string, userId: number) => {
    const res = await s.call("/api/auto-review/webhooks/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": "Note Hook", "x-gitlab-token": secret },
      json: {
        object_kind: "note",
        user: { id: userId, bot: false },
        project: { id: 21 },
        object_attributes: { id: ids++, note: body, noteable_type: "MergeRequest" },
        merge_request: { iid: 3 },
      },
    });
    await s.host.idle();
    return res.json();
  };

  it("resolves only ocra's open threads", async () => {
    expect(await note("@ocra resolve", 5)).toEqual({ queued: 1 });
    expect(writes()).toEqual([
      { method: "PUT", url: `${MR}/discussions/open-finding`, body: { resolved: true } },
      {
        method: "POST",
        url: `${MR}/notes`,
        body: { body: "Resolved 1 of ocra's open threads." },
      },
    ]);
  });

  it("queues tests for the head, and refuses a role below Developer", async () => {
    await note("@ocra generate tests", 6);
    expect(writes()).toEqual([]);
    await note("@ocra generate tests", 5);
    const generated = await s.host.db.select().from(schema.generateJobs);
    expect(generated.map((g) => [g.number, g.head, g.kind])).toEqual([[3, C2, "tests"]]);
    expect((await commands()).map((c) => c.outcome)).toEqual(["refused", "done"]);
  });
});

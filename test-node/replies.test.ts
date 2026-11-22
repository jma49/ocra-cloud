import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { claimReply } from "../src/db/reply-jobs.js";
import * as schema from "../src/db/schema.js";
import { C1, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// An @ocra comment on an enrolled repository's pull request queues one
// answer, from a person, never a bot.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-replies-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
beforeEach(async () => {
  s = await graphServer(dir, `replies-${n++}.db`, "off", undefined, { bots: {}, workers: 0 });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const enroll = async (json: Record<string, unknown>) => {
  const { auth } = await s.signIn(1);
  return s.call("/api/auto-review/repos", { method: "POST", headers: auth, json });
};

const replies = () => s.host.db.select().from(schema.replyJobs).orderBy(schema.replyJobs.createdAt);

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
  return (await res.json()) as { queued: number };
}

const repository = { id: 11, full_name: "Octo/API" };
const comment = (id: number, body: string, type = "User") => ({ id, body, user: { type } });

describe("an @ocra comment on GitHub", () => {
  beforeEach(() => enroll({ platform: "github", fullName: "octo/api" }));

  it("queues one answer, on the conversation or inline", async () => {
    const asked = {
      action: "created",
      comment: comment(501, "@ocra why is this unsafe?"),
      issue: { number: 7, pull_request: { url: "x" } },
      repository,
    };
    expect(await fromGithub("issue_comment", asked)).toEqual({ queued: 1 });
    expect(await fromGithub("issue_comment", asked)).toEqual({ queued: 0 });
    const inline = {
      action: "created",
      comment: comment(502, "@OCRA explain"),
      pull_request: { number: 7 },
      repository,
    };
    expect(await fromGithub("pull_request_review_comment", inline)).toEqual({ queued: 1 });
    expect((await replies()).map((r) => [r.number, r.commentId, r.inline, r.state])).toEqual([
      [7, "501", false, "queued"],
      [7, "502", true, "queued"],
    ]);
  });

  it("skips a bot, a comment without the mention, an issue, an edit and another repository", async () => {
    const pull = { number: 7, pull_request: { url: "x" } };
    const skipped = [
      { action: "created", comment: comment(1, "@ocra hi", "Bot"), issue: pull, repository },
      { action: "created", comment: comment(2, "@ocrabot hi"), issue: pull, repository },
      { action: "created", comment: comment(3, "@ocra hi"), issue: { number: 7 }, repository },
      { action: "edited", comment: comment(4, "@ocra hi"), issue: pull, repository },
      {
        action: "created",
        comment: comment(5, "@ocra hi"),
        issue: pull,
        repository: { id: 99, full_name: "x/y" },
      },
    ];
    for (const event of skipped) {
      expect(await fromGithub("issue_comment", event)).toEqual({ queued: 0 });
    }
    expect(await replies()).toEqual([]);
  });

  it("is claimed by one runner at a time, and again once its lease lapses", async () => {
    await fromGithub("issue_comment", {
      action: "created",
      comment: comment(501, "@ocra?"),
      issue: { number: 7, pull_request: {} },
      repository,
    });
    const now = new Date();
    expect(await claimReply(s.host.db, now, 60_000)).toMatchObject({
      commentId: "501",
      attempts: 1,
    });
    expect(await claimReply(s.host.db, now, 60_000)).toBeUndefined();
    const later = new Date(now.getTime() + 120_000);
    expect(await claimReply(s.host.db, later, 60_000)).toMatchObject({ attempts: 2 });
  });
});

describe("an @ocra note on GitLab", () => {
  it("is proven by the repository's secret and queues an answer on a merge request only", async () => {
    const res = await enroll({ platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const note = (
      attributes: Record<string, unknown>,
      over: { token?: string; bot?: boolean } = {},
    ) =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Note Hook", "x-gitlab-token": over.token ?? webhook.secret },
        json: {
          object_kind: "note",
          user: { bot: over.bot ?? false },
          project: { id: 21 },
          object_attributes: {
            id: 900,
            note: "@ocra why?",
            noteable_type: "MergeRequest",
            ...attributes,
          },
          merge_request: { iid: 3 },
        },
      });
    expect((await note({}, { token: "wrong" })).status).toBe(401);
    expect(await (await note({})).json()).toEqual({ queued: 1 });
    expect(await (await note({})).json()).toEqual({ queued: 0 });
    expect(await (await note({ id: 901 }, { bot: true })).json()).toEqual({ queued: 0 });
    expect(await (await note({ id: 902, noteable_type: "Issue" })).json()).toEqual({ queued: 0 });
    expect(await (await note({ id: 903, note: "no mention" })).json()).toEqual({ queued: 0 });
    expect((await replies()).map((r) => [r.number, r.commentId, r.inline])).toEqual([
      [3, "900", false],
    ]);
  });
});

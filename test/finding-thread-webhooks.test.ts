import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { scoped } from "../src/db/scoped.js";
import { seed } from "./fix-fakes.js";
import { call, db, request, resetDb, signIn } from "./helpers.js";

// The GitHub App's deliveries about the thread of ocra's comment of a
// finding reach the finding as the review's page reads it, the same
// however often each is delivered.

beforeEach(resetDb);

const SECRET = "finding-threads-secret";
const FP = "0123456789abcdef";

const bot = { id: 900, login: "ocra[bot]", type: "Bot" };
const rita = { id: 7, login: "rita", type: "User" };
const first = {
  id: 100,
  body: `<!-- ocra:finding ${FP} -->\n**Bug.** The lock is taken twice.`,
  user: bot,
  created_at: "2026-11-02T10:00:00Z",
};
const answer = {
  id: 101,
  body: "Not a bug here: the lock is reentrant.",
  user: rita,
  created_at: "2026-11-02T11:00:00Z",
  in_reply_to_id: 100,
};
const repository = { id: 11 };
const commented = (comment: unknown) => ({
  action: "created",
  pull_request: { number: 7, title: "T" },
  comment,
  repository,
});
const changed = (action: string, at: string, root: Record<string, unknown> = first) => ({
  action,
  pull_request: { number: 7, updated_at: at },
  thread: { node_id: "T1", comments: [root, answer] },
  sender: rita,
  repository,
});

/** One delivery; the same id again is GitHub delivering it again. */
async function deliver(event: string, payload: unknown, delivery: string = crypto.randomUUID()) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
  });
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
    }),
    env,
    ctx,
  );
  await res.text();
  await waitOnExecutionContext(ctx);
  return res.status;
}

async function setUp() {
  const me = await signIn(42, "mona");
  await scoped(db, me.account.id).insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  const { reviewId } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
  const found = async () => {
    const res = await call(`/api/reviews/${reviewId}`, { auth: me.auth });
    const { findings } = (await res.json()) as { findings: Record<string, unknown>[] };
    return findings[0];
  };
  return Object.assign(async () => (await found())?.platformDismissal, { found });
}

describe("the App's deliveries about a finding's thread", () => {
  it("shows nothing on a finding whose thread nobody touched", async () => {
    const dismissal = await setUp();
    expect(await deliver("pull_request_review_comment", commented(first))).toBe(202);
    expect(await dismissal()).toBeNull();
  });

  it("keeps a person's reply, then who resolved the thread and who opened it again", async () => {
    const dismissal = await setUp();
    const again = crypto.randomUUID();
    await deliver("pull_request_review_comment", commented(first));
    await deliver("pull_request_review_comment", commented(answer), again);
    await deliver("pull_request_review_comment", commented(answer), again);
    expect(await dismissal()).toEqual({
      state: null,
      by: null,
      at: null,
      reason: "Not a bug here: the lock is reentrant.",
      reasonBy: "rita",
      reasonAt: "2026-11-02T11:00:00.000Z",
      redacted: false,
      truncated: false,
    });
    const resolved = changed("resolved", "2026-11-02T12:00:00Z");
    expect(await deliver("pull_request_review_thread", resolved)).toBe(202);
    expect(await dismissal()).toMatchObject({
      state: "resolved",
      by: "rita",
      at: "2026-11-02T12:00:00.000Z",
    });
    await deliver("pull_request_review_thread", changed("unresolved", "2026-11-02T13:00:00Z"));
    // The resolution again, late: the thread stays open.
    await deliver("pull_request_review_thread", resolved);
    expect(await dismissal()).toMatchObject({
      state: "unresolved",
      by: "rita",
      at: "2026-11-02T13:00:00.000Z",
      reason: "Not a bug here: the lock is reentrant.",
    });
  });

  it("keeps the 👍 and 👎 its thread's event carries on the finding, a late older one changing nothing", async () => {
    const { found } = await setUp();
    const reacted = (up: number, down: number) => ({
      ...first,
      reactions: { url: "https://api.github.com/x", total_count: up + down, "+1": up, "-1": down },
    });
    await deliver(
      "pull_request_review_thread",
      changed("resolved", "2026-11-02T12:00:00Z", reacted(2, 1)),
    );
    expect(await found()).toMatchObject({ thumbsUp: 2, thumbsDown: 1 });
    await deliver(
      "pull_request_review_thread",
      changed("unresolved", "2026-11-02T13:00:00Z", reacted(3, 0)),
    );
    await deliver(
      "pull_request_review_thread",
      changed("resolved", "2026-11-02T12:00:00Z", reacted(2, 1)),
    );
    expect(await found()).toMatchObject({
      thumbsUp: 3,
      thumbsDown: 0,
      reactionsReadAt: "2026-11-02T13:00:00.000Z",
    });
  });
});

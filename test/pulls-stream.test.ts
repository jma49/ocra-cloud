import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import uploaded from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { scoped } from "../src/db/scoped.js";
import { durableHub } from "../src/pull-events/durable.js";
import { MAX_STREAMS } from "../src/pull-events/hub.js";
import type { PullsChangedEvent } from "../src/shared/index.js";
import { db, request, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

// The open inbox hears its account's pull request changes as webhooks
// bring them, through the account's Durable Object: never another
// account's, never more streams than an account may hold.

const SECRET = "pulls-stream-secret";

const app = createApp({
  openDb: (e: Env) => drizzle(e.DB),
  clientAddress: () => "192.0.2.1",
  githubWebhookSecret: SECRET,
  pullsHub: durableHub(env.PULL_EVENTS),
});

beforeEach(resetDb);

async function open(auth: Record<string, string>) {
  const res = await app.fetch(
    request("/api/platforms/pulls/changed/stream", { auth }),
    env,
    createExecutionContext(),
  );
  return res;
}

function readerOf(res: Response) {
  if (!res.body) throw new Error("no stream");
  return res.body.getReader();
}

/** Reads the stream until an event named `name`, or fails after `ms`. */
async function next(reader: ReadableStreamDefaultReader<Uint8Array>, name: string, ms = 5_000) {
  const decoder = new TextDecoder();
  let text = "";
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()));
    const chunk = await Promise.race([reader.read(), timeout]);
    if (!chunk || chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    const block = text.split("\n\n").find((b) => b.split("\n").includes(`event: ${name}`));
    if (block) return block.match(/^data: ?(.*)$/m)?.[1] ?? "";
  }
  return null;
}

async function deliver(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
    }),
    env,
    ctx,
  );
  await res.text();
  await waitOnExecutionContext(ctx);
  expect(res.status).toBeLessThan(300);
}

describe("the inbox's stream of changes", () => {
  it("pushes a webhook's change to the account's open stream only", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "ada");
    const repoId = await scoped(db, me.account.id).insert("reviewRepos", {
      ...rows.reviewRepos("api"),
      platformRepoId: "11",
    });
    const mine = await open(me.auth);
    const theirs = await open(other.auth);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toContain("text/event-stream");
    const reader = readerOf(mine);
    const theirReader = readerOf(theirs);
    expect(await next(reader, "ready")).toBe("");
    expect(await next(theirReader, "ready")).toBe("");

    const comment = { action: "created", issue: { number: 7, pull_request: { url: "x" } } };
    await deliver("issue_comment", { ...comment, repository: { id: 11, full_name: "octo/api" } });
    const heard = JSON.parse((await next(reader, "pulls")) ?? "null") as PullsChangedEvent[];
    expect(heard).toEqual([{ repoId, number: 7, kind: "comment" }]);
    expect(await next(theirReader, "pulls", 500)).toBeNull();

    // A delivery that changes no pull request is not pushed.
    await deliver("push", {
      ref: "refs/heads/main",
      repository: { id: 11, full_name: "octo/api" },
    });
    expect(await next(reader, "pulls", 500)).toBeNull();
    await reader.cancel();
    await theirReader.cancel();
  });

  it("pushes an uploaded review to the account's open stream only", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "ada");
    const repoId = await scoped(db, me.account.id).insert("reviewRepos", rows.reviewRepos("app"));
    const reader = readerOf(await open(me.auth));
    const theirReader = readerOf(await open(other.auth));
    expect(await next(reader, "ready")).toBe("");
    expect(await next(theirReader, "ready")).toBe("");

    const upload = async (auth: Record<string, string>, json: unknown) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        request("/api/reviews", { method: "POST", auth, json }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await res.text();
      await waitOnExecutionContext(ctx);
    };
    const cli = (await signInCli(1, "octo")).auth;
    await upload(cli, uploaded);
    const heard = JSON.parse((await next(reader, "pulls", 2_000)) ?? "null") as PullsChangedEvent[];
    expect(heard).toEqual([{ repoId, number: uploaded.pullRequest.number, kind: "review" }]);
    // A review of no enrolled repository's pull request moves the change time all the same.
    const { pullRequest: _, ...local } = uploaded;
    await upload(cli, { ...local, runId: "run-local" });
    expect(JSON.parse((await next(reader, "pulls")) ?? "null")).toEqual([
      { repoId: null, number: null, kind: "review" },
    ]);
    expect(await next(theirReader, "pulls", 500)).toBeNull();
    await reader.cancel();
    await theirReader.cancel();
  });

  it(`holds at most ${MAX_STREAMS} streams of one account`, async () => {
    const me = await signIn(1, "octo");
    const held = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      const res = await open(me.auth);
      expect(res.status).toBe(200);
      held.push(readerOf(res));
    }
    const refused = await open(me.auth);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "slow_down" });
    // Another account's are its own.
    expect((await open((await signIn(2, "ada")).auth)).status).toBe(200);
    for (const r of held) await r.cancel();
  });

  it("is a web session's only", async () => {
    expect((await open({})).status).toBe(401);
    const { auth } = await signInCli(1, "octo");
    expect((await open(auth)).status).toBe(403);
  });
});

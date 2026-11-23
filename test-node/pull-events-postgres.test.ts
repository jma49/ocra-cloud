import { resolve } from "node:path";
import upload from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import { scoped } from "../src/db/scoped.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { startCliSession, startWebSession } from "../src/session.js";
import type { PullsChangedEvent } from "../src/shared/index.js";
import { type RealPostgres, realPostgresAvailable, startRealPostgres } from "./real-postgres.js";

// Several Node processes on one Postgres: a change one of them hears (a
// webhook, an uploaded review) reaches the inbox streams the others hold,
// through LISTEN/NOTIFY; never another account's, never twice.

const ORIGIN = "http://ocra.test";
const SECRET = "hook-secret";
const bindings = bindingsFrom({
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
});

type Host = Awaited<ReturnType<typeof openHost>>;
const hosts: Host[] = [];
let server: RealPostgres | undefined;

const available = realPostgresAvailable();

beforeAll(async () => {
  if (available) server = await startRealPostgres();
}, 60_000);

afterAll(async () => {
  for (const h of hosts) h.close();
  await server?.stop();
});

async function open(migrate: boolean) {
  if (!server) throw new Error("no server");
  const host = await openHost({
    databaseUrl: server.url,
    bindings,
    migrations: resolve("migrations"),
    githubWebhookSecret: SECRET,
    migrate,
  });
  hosts.push(host);
  return host;
}

type Events = { next(name: string, ms?: number): Promise<string | null>; cancel(): Promise<void> };

async function stream(host: Host, auth: Record<string, string>): Promise<Events> {
  const res = await host.fetch(
    new Request(`${ORIGIN}/api/platforms/pulls/changed/stream`, { headers: auth }),
  );
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  // A read that outlived one wait is the next wait's, so no event is lost between them.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  /** The data of the next event named `name`; null when none came within `ms`. */
  const next = async (name: string, ms = 5_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const blocks = text.split("\n\n");
      const at = blocks.findIndex(
        (b, i) => i < blocks.length - 1 && b.split("\n").includes(`event: ${name}`),
      );
      if (at >= 0) {
        text = blocks.slice(at + 1).join("\n\n");
        return blocks[at]?.match(/^data: ?(.*)$/m)?.[1] ?? "";
      }
      if (Date.now() >= until) return null;
      pending ??= reader.read();
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()));
      const chunk = await Promise.race([pending, timeout]);
      if (!chunk) return null;
      pending = null;
      if (chunk.done) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  expect(await next("ready")).toBe("");
  return { next, cancel: () => reader.cancel() };
}

const heard = (data: string | null) => JSON.parse(data ?? "null") as PullsChangedEvent[] | null;

describe.skipIf(!available)("the inbox's streams across processes on Postgres", () => {
  it("hear a webhook and an upload another process received, once", async () => {
    const a = await open(true);
    const b = await open(false);
    const me = await upsertAccount(a.db, githubIdentity(1), "ada");
    const other = await upsertAccount(a.db, githubIdentity(2), "bob");
    const web = { authorization: `Bearer ${await startWebSession(a.db, me.id)}` };
    const theirs = { authorization: `Bearer ${await startWebSession(a.db, other.id)}` };
    const repo = (name: string, id: string) =>
      scoped(a.db, me.id).insert("reviewRepos", {
        platform: "github",
        host: "github.com",
        platformRepoId: id,
        fullName: `octo/${name}`,
      });
    const api = await repo("api", "11");
    const app = await repo("app", "12");

    const onB = await stream(b, web);
    const onA = await stream(a, web);
    const otherOnB = await stream(b, theirs);

    const body = JSON.stringify({
      action: "created",
      issue: { number: 7, pull_request: { url: "x" } },
      repository: { id: 11, full_name: "octo/api" },
    });
    const sent = await a.fetch(
      new Request(`${ORIGIN}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
        },
        body,
      }),
    );
    expect(sent.status).toBe(202);
    const comment = [{ repoId: api, number: 7, kind: "comment" }];
    expect(heard(await onB.next("pulls"))).toEqual(comment);
    expect(heard(await onA.next("pulls"))).toEqual(comment);
    expect(await onA.next("pulls", 300)).toBeNull();
    expect(await otherOnB.next("pulls", 300)).toBeNull();

    const cli = (await startCliSession(a.db, me.id, "t")).access_token;
    const stored = await b.fetch(
      new Request(`${ORIGIN}/api/reviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${cli}`, "content-type": "application/json" },
        body: JSON.stringify(upload),
      }),
    );
    expect(stored.status).toBe(200);
    const review = [{ repoId: app, number: upload.pullRequest.number, kind: "review" }];
    expect(heard(await onA.next("pulls"))).toEqual(review);
    expect(heard(await onB.next("pulls"))).toEqual(review);
    expect(await otherOnB.next("pulls", 300)).toBeNull();
    for (const r of [onA, onB, otherOnB]) await r.cancel();
  });
});

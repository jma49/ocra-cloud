import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { remoteReviews } from "../src/auto-review/remote.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { RestackHistoryView } from "../src/shared/index.js";
import { githubMerged } from "../src/stack-merge/hooks.js";
import { db, ORIGIN } from "./helpers.js";
import { signInWithGithub } from "./platform-fakes.js";
import { enroll, mergeOf, sha } from "./stack-fakes.js";

// What the restack tests share: an enrolled repository whose restack switch
// and history are read and set through the API, and #1 merged by squash.

export type Session = Awaited<ReturnType<typeof signInWithGithub>>;

// The auto review routes are there where the server runs reviews.
const app = createApp({
  openDb: (bindings: typeof env) => drizzle(bindings.DB),
  clientAddress: () => "203.0.113.9",
  ...remoteReviews({
    GITLAB_CLIENT_ID: env.GITLAB_CLIENT_ID,
    GITLAB_CLIENT_SECRET: env.GITLAB_CLIENT_SECRET,
    MASTER_KEY: env.MASTER_KEY,
    RUNNER_TOKEN: "r".repeat(40),
  }),
});

async function ask(a: Session, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = { cookie: a.cookie, origin: ORIGIN, ...init.headers };
  const res = await app.fetch(new Request(ORIGIN + path, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function setUp() {
  const a = await signInWithGithub();
  const [account] = await db.select().from(schema.accounts);
  const data = scoped(db, account?.id ?? "");
  return { a, data, repo: await enroll(data) };
}

export const turn = (a: Session, on: boolean) =>
  ask(a, "/api/auto-review/repos/r/restack", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restack: on }),
  });

export async function history(a: Session): Promise<RestackHistoryView> {
  const res = await ask(a, "/api/auto-review/repos/r/restacks");
  expect(res.status).toBe(200);
  return (await res.json()) as RestackHistoryView;
}

export const mergedOne = githubMerged("pull_request", {
  action: "closed",
  number: 1,
  pull_request: {
    merged: true,
    merge_commit_sha: mergeOf(1),
    head: { ref: "step-1", sha: sha(1) },
    base: { ref: "main" },
  },
});

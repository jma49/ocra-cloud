import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { AutoReviewService } from "../src/auto-review/routes.js";
import { hmacHex } from "../src/crypto.js";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { engineGraphParser } from "../src/node/engine-graph.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { github } from "../src/platforms/github.js";
import { gitlab } from "../src/platforms/gitlab.js";
import { saveToken } from "../src/platforms/links.js";
import { githubClientOf, gitlabCallback, gitlabClientOf } from "../src/platforms/registry.js";
import { startWebSession } from "../src/session.js";
import type { GraphPolicy } from "../src/shared/index.js";
import { fakeBuilder, GITLAB } from "./graph-fakes.js";

export const ORIGIN = "http://ocra.test";
export const SECRET = "hook-secret";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  GITLAB_CLIENT_ID: "lab-app",
  GITLAB_CLIENT_SECRET: "lab-secret",
  GITLAB_URL: GITLAB,
};
const bindings = bindingsFrom(VARS);
const githubClient = githubClientOf(bindings);
if (!githubClient) throw new Error("the test bindings configure GitHub");
const githubPlatform = github(githubClient);

/** A self-hosted server on a database file in dir, with a fake builder and signed-in accounts. */
export async function graphServer(
  dir: string,
  file: string,
  policy: GraphPolicy,
  builder = fakeBuilder(),
  autoReview?: AutoReviewService,
) {
  const host = await openHost({
    databaseUrl: `file:${join(dir, file)}`,
    bindings,
    migrations: resolve("migrations"),
    publicUrl: ORIGIN,
    graphs: {
      policy,
      builder: builder.builder,
      parse: engineGraphParser,
    },
    githubWebhookSecret: SECRET,
    ...(autoReview ? { autoReview } : {}),
  });
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set("content-type", "application/json");
    return host.fetch(
      new Request(ORIGIN + path, {
        ...rest,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      }),
    );
  };
  const signIn = async (githubId: number) => {
    const account = await upsertAccount(host.db, githubIdentity(githubId), `user-${githubId}`);
    const data = scoped(host.db, account.id);
    await saveToken(data, bindings, githubPlatform, { access_token: `ghu_${githubId}` });
    const lab = gitlabClientOf(bindings);
    if (lab) {
      await saveToken(data, bindings, gitlab(lab, gitlabCallback(ORIGIN)), {
        access_token: `glpat_${githubId}`,
      });
    }
    return {
      account,
      data,
      auth: { authorization: `Bearer ${await startWebSession(host.db, account.id)}` },
    };
  };
  const settled = () => vi.waitFor(() => expect(host.graphWorker?.busy() ?? false).toBe(false));
  const builds = (accountId: string) =>
    host.db
      .select()
      .from(schema.graphBuilds)
      .where(eq(schema.graphBuilds.accountId, accountId))
      .orderBy(schema.graphBuilds.createdAt);
  return { host, call, signIn, settled, builds, builder };
}

export type Server = Awaited<ReturnType<typeof graphServer>>;

export const githubPush = (ref: string, after: string, fullName = "Octo/API") =>
  JSON.stringify({
    ref,
    after,
    repository: { id: 11, full_name: fullName, default_branch: "main" },
  });

export async function pushToGithub(s: Server, body: string, signature?: string) {
  return s.call("/api/graphs/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": signature ?? `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

export const addRepo = (s: Server, auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/graphs/repos", { method: "POST", headers: auth, json });

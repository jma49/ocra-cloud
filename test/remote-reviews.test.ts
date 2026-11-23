import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { remoteReviews } from "../src/auto-review/remote.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { appJwt } from "../src/platforms/bot-tokens.js";
import { platformsOf } from "../src/platforms/registry.js";
import { db, ORIGIN, request, resetDb, signIn } from "./helpers.js";

// A host that runs no job itself queues hosted reviews for remote runners
// once it has a runner token and a bot: the GitHub App's key with its
// webhook secret, GitLab's bot token, or both; the App's JWT is signed with
// Web Crypto, which the Worker has.

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

const bytes = (base64url: string) =>
  Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("the ocra bot's App JWT", () => {
  it("is signed on this runtime with the App's key", async () => {
    const { pem, publicKey } = await keyPair();
    const [head = "", body = "", signature = ""] = (await appJwt("42", pem, 1_000_000)).split(".");
    expect(
      await crypto.subtle.verify(
        RSA.name,
        publicKey,
        bytes(signature),
        new TextEncoder().encode(`${head}.${body}`),
      ),
    ).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bytes(body)))).toMatchObject({ iss: "42" });
  });
});

describe("hosted reviews for remote runners", () => {
  const vars = {
    GITHUB_APP_ID: "42",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "hook-secret",
    RUNNER_TOKEN: "runner-token-of-at-least-32-characters",
  };

  it("are on on GitHub only with the App's key, the webhook secret and a runner token", () => {
    expect(remoteReviews(vars)).toMatchObject({
      autoReview: { remote: true, githubAppId: "42" },
      runnerToken: vars.RUNNER_TOKEN,
      githubWebhookSecret: "hook-secret",
    });
    for (const name of Object.keys(vars)) {
      expect(remoteReviews({ ...vars, [name]: undefined })).toEqual({});
    }
  });

  it("refuse a runner token short enough to guess", () => {
    expect(() => remoteReviews({ ...vars, RUNNER_TOKEN: "short" })).toThrow(/RUNNER_TOKEN/);
  });
});

describe("hosted reviews for remote runners on a server with GitLab only", () => {
  const RUNNER = "runner-token-of-at-least-32-characters";
  const gitlabOnly = { GITLAB_BOT_TOKEN: "glpat-bot", RUNNER_TOKEN: RUNNER };

  it("are on with GitLab's bot token and a runner token, without a GitHub App", async () => {
    const remote = remoteReviews(gitlabOnly);
    expect(remote).toMatchObject({ autoReview: { remote: true }, runnerToken: RUNNER });
    expect(remote).not.toHaveProperty("githubWebhookSecret");
    expect(await remote.bots?.forRepo("gitlab", "acme/api")).toEqual({ token: "glpat-bot" });
    expect(await remote.bots?.forRepo("github", "Octo/API")).toBeNull();
    expect(remoteReviews({ ...gitlabOnly, RUNNER_TOKEN: undefined })).toEqual({});
    expect(remoteReviews({ ...gitlabOnly, GITLAB_BOT_TOKEN: undefined })).toEqual({});
  });

  it("keep a mixed server's GitHub App and webhook secret", () => {
    const mixed = remoteReviews({
      ...gitlabOnly,
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: "key",
      GITHUB_WEBHOOK_SECRET: "hook-secret",
    });
    expect(mixed).toMatchObject({ runnerToken: RUNNER, githubWebhookSecret: "hook-secret" });
  });

  describe("a runner's claim", () => {
    const app = createApp({
      openDb: (bindings: typeof env) => drizzle(bindings.DB),
      clientAddress: () => "203.0.113.9",
      ...remoteReviews(gitlabOnly),
    });
    const asRunner = async (path: string, json: unknown) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        request(`/api/runner/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${RUNNER}` },
          json,
        }),
        env,
        ctx,
      );
      const body = await res.json();
      await waitOnExecutionContext(ctx);
      return { status: res.status, body };
    };
    const lab = platformsOf(env, ORIGIN).find((p) => p.kind === "gitlab");
    let accountId: string;

    beforeEach(async () => {
      await resetDb();
      accountId = (await signIn(1, "user-1")).account.id;
      const jobs = scoped(db, accountId).autoReview;
      const repo = await jobs.enroll(
        { platform: "gitlab", host: lab?.host ?? "", platformRepoId: "11", fullName: "acme/api" },
        100,
      );
      await jobs.queue(repo ?? "", 7, "c".repeat(40), new Date());
    });

    it("gives a GitLab merge request's review the bot's token, and its report ends the job", async () => {
      const claimed = await asRunner("claim", { name: "mini", version: "0.14.0" });
      expect(claimed.status).toBe(200);
      const { assignment } = claimed.body as { assignment: Record<string, unknown> };
      expect(assignment).toMatchObject({
        kind: "review",
        accountId,
        repo: { platform: "gitlab", url: lab?.url, fullName: "acme/api" },
        bot: { token: "glpat-bot" },
        args: expect.arrayContaining(["review", "--mr", "7", "--project", "acme/api"]),
      });
      const settled = await asRunner("settle", {
        kind: "review",
        id: assignment.id,
        accountId,
        attempts: assignment.attempts,
        failure: null,
      });
      expect(settled.status).toBe(200);
      const [job] = await db.select().from(schema.reviewJobs);
      expect(job).toMatchObject({ state: "done", error: null });
    });
  });
});

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { scoped } from "../src/db/scoped.js";
import { db, request, resetDb, signIn } from "./helpers.js";

// GitHub's Re-run of the `ocra / pre-merge` check run, or of the App's
// check suite, opens the head's posted result to be evaluated and posted
// again: only the App's own run, of a repository enrolled here, once.

beforeEach(resetDb);

const SECRET = "hook-secret";
const APP_ID = 42;
const HEAD = "a".repeat(40);

function appWith(checkPull: (accountId: string, repoId: string, number: number) => void) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
    autoReview: { kick: () => {}, checkPull, githubAppId: String(APP_ID) },
  });
  return async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
        },
        body,
      }),
      env,
      ctx,
    );
    await res.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return res.status;
  };
}

/** An enrolled repository whose head of pull request 7 was posted as check run 900. */
async function posted() {
  const me = await signIn(1, "octo");
  const data = scoped(db, me.account.id);
  await data.insert("reviewRepos", {
    id: "repo-1",
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "Octo/API",
  });
  const runs = data.mergeChecks;
  const run = { reviewRepoId: "repo-1", number: 7, head: HEAD, conclusion: "failure" as const };
  const id = `${await runs.record({ ...run, results: [], digest: "d" }, new Date())}`;
  expect(await runs.claimPost(id, "d")).toBe(true);
  await data.update("mergeCheckRuns", id, { externalId: "900", postedAt: new Date() });
  return { accountId: me.account.id, data, id };
}

const checkRun = (over: Record<string, unknown> = {}, appId = APP_ID) => ({
  action: "rerequested",
  check_run: {
    id: 900,
    name: "ocra / pre-merge",
    head_sha: HEAD.toUpperCase(),
    app: { id: appId },
    ...over,
  },
  repository: { id: 11 },
});

describe("a re-run of the pre-merge check run", () => {
  it("evaluates the head's checks again, once however often GitHub asks", async () => {
    const { accountId, data, id } = await posted();
    const checkPull = vi.fn();
    const send = appWith(checkPull);
    expect(await send("check_run", checkRun())).toBe(202);
    expect(checkPull).toHaveBeenCalledExactlyOnceWith(accountId, "repo-1", 7);
    expect((await data.get("mergeCheckRuns", id))?.postedDigest).toBeNull();
    expect(await send("check_run", checkRun())).toBe(202);
    expect(checkPull).toHaveBeenCalledTimes(1);
    // Posted again, the next re-run is taken.
    expect(await data.mergeChecks.claimPost(id, "d")).toBe(true);
    await send("check_run", checkRun());
    expect(checkPull).toHaveBeenCalledTimes(2);
  });

  it("is ignored for another App's run, another check's name or a run not posted here", async () => {
    const { data, id } = await posted();
    const checkPull = vi.fn();
    const send = appWith(checkPull);
    await send("check_run", checkRun({}, APP_ID + 1));
    await send("check_run", checkRun({ name: "ci / test" }));
    await send("check_run", checkRun({ id: 901 }));
    await send("check_run", checkRun({ head_sha: "b".repeat(40) }));
    await send("check_run", { ...checkRun(), repository: { id: 12 } });
    await send("check_run", { ...checkRun(), action: "completed" });
    expect(checkPull).not.toHaveBeenCalled();
    expect((await data.get("mergeCheckRuns", id))?.postedDigest).toBe("d");
  });

  it("is taken from a re-run of the App's check suite on that head", async () => {
    const { accountId } = await posted();
    const checkPull = vi.fn();
    const send = appWith(checkPull);
    const suite = (appId: number) => ({
      action: "rerequested",
      check_suite: { head_sha: HEAD, app: { id: appId } },
      repository: { id: 11 },
    });
    await send("check_suite", suite(APP_ID + 1));
    expect(checkPull).not.toHaveBeenCalled();
    await send("check_suite", suite(APP_ID));
    expect(checkPull).toHaveBeenCalledExactlyOnceWith(accountId, "repo-1", 7);
  });
});

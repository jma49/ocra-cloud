import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { accountSalt } from "../src/db/accounts.js";
import { claimJob } from "../src/db/review-jobs.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { repoHashOf } from "../src/platforms/platform.js";
import { githubHostOf } from "../src/platforms/registry.js";
import { db, request, resetDb, signIn } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { account, hourly } from "./reconcile-fakes.js";
import { rows } from "./table-rows.js";

// What becomes of an enrolled repository as it changes on its platform: a
// rename or transfer keeps its enrollment and history under the new name; a
// removal, deletion, suspension or uninstall pauses it, and adding it back,
// unsuspending or installing again resumes it.

const SECRET = "lifecycle-secret";
const app = createApp({
  openDb: (e: Env) => drizzle(e.DB),
  clientAddress: () => "192.0.2.1",
  githubWebhookSecret: SECRET,
  autoReview: { kick: () => {} },
});

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
      body,
    }),
    env,
    ctx,
  );
  await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
}

/** An account with octo/<name> enrolled, its id `repo-<name>` and GitHub's id `<githubId>`. */
async function enrolled(n: number, repos: { name: string; githubId: number }[]) {
  const { account: me } = await signIn(n, `user-${n}`);
  for (const r of repos) {
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(`repo-${r.name}`),
      accountId: me.id,
      platformRepoId: String(r.githubId),
      fullName: `octo/${r.name}`,
    });
  }
  return { id: me.id, data: scoped(db, me.id) };
}

const repoOf = async (id: string) =>
  (await db.select().from(schema.reviewRepos)).find((r) => r.id === id);

beforeEach(async () => {
  await resetDb();
  await db.delete(schema.inboundEvents);
});
afterEach(() => vi.restoreAllMocks());

describe("a repository renamed or transferred on GitHub", () => {
  it("keeps its enrollment, settings and history under the new name", async () => {
    const me = await enrolled(1, [{ name: "api", githubId: 501 }]);
    const site = githubHostOf(env);
    const salt = await accountSalt(db, me.id);
    const oldHash = await repoHashOf(salt, site, "octo/api");
    const newHash = await repoHashOf(salt, site, "acme/service");
    await db.update(schema.reviewRepos).set({ reviewProfile: "quiet" });
    await db.insert(schema.graphRepos).values({
      ...rows.graphRepos("g"),
      accountId: me.id,
      platformRepoId: "501",
      fullName: "octo/api",
    });
    await db.insert(schema.pullFlows).values({
      ...rows.pullFlows("flow"),
      accountId: me.id,
      reviewRepoId: "repo-api",
    });
    await db.insert(schema.mergeIntents).values({
      ...rows.mergeIntents("i"),
      accountId: me.id,
      fullName: "octo/api",
    });
    await db
      .insert(schema.pullSeen)
      .values({ ...rows.pullSeen("s"), accountId: me.id, repo: "octo/api" });
    await db.insert(schema.reviews).values({
      ...rows.reviews("rv"),
      accountId: me.id,
      repoHash: oldHash,
      prRepository: "octo/api",
      prNumber: 3,
    });
    await db.insert(schema.accountMemory).values({
      ...rows.accountMemory("m"),
      accountId: me.id,
      repoHash: oldHash,
    });

    await deliver("repository", {
      action: "transferred",
      repository: { id: 501, full_name: "acme/service" },
    });

    const repo = await repoOf("repo-api");
    expect(repo).toMatchObject({ fullName: "acme/service", reviewProfile: "quiet", paused: null });
    expect(await me.data.list("pullFlows")).toHaveLength(1);
    expect((await me.data.list("graphRepos"))[0]?.fullName).toBe("acme/service");
    expect((await me.data.list("mergeIntents"))[0]?.fullName).toBe("acme/service");
    expect((await me.data.list("pullSeen"))[0]?.repo).toBe("acme/service");
    expect(await me.data.list("reviews")).toMatchObject([
      { repoHash: newHash, prRepository: "acme/service" },
    ]);
    expect((await me.data.list("accountMemory"))[0]?.repoHash).toBe(newHash);
    expect((await me.data.list("auditEvents")).map((e) => [e.kind, e.detail])).toContainEqual([
      "auto_review.renamed",
      { repo: "acme/service", previous: "octo/api" },
    ]);
  });
});

describe("a repository GitHub no longer gives the App", () => {
  it("is paused when removed, its queued jobs given up, and resumes when added back", async () => {
    const me = await enrolled(1, [
      { name: "api", githubId: 501 },
      { name: "web", githubId: 502 },
    ]);
    await me.data.autoReview.queue("repo-api", 4, "a".repeat(40), new Date());

    await deliver("installation_repositories", {
      action: "removed",
      installation: { id: 7, account: { login: "octo" } },
      repositories_removed: [{ id: 501, full_name: "octo/api" }],
    });
    expect((await repoOf("repo-api"))?.paused).toBe("removed");
    expect((await repoOf("repo-web"))?.paused).toBeNull();
    expect(await me.data.list("reviewJobs")).toMatchObject([
      { state: "failed", error: "repository_paused" },
    ]);
    // Asked for again while paused, it waits: no runner claims it.
    await me.data.autoReview.request("repo-api", 4, "b".repeat(40), false, new Date());
    expect(await claimJob(db, new Date(), 60_000, 1000)).toBeUndefined();

    await deliver("installation_repositories", {
      action: "added",
      installation: { id: 7 },
      repositories_added: [{ id: 501, full_name: "octo/api" }],
    });
    expect((await repoOf("repo-api"))?.paused).toBeNull();
    expect((await claimJob(db, new Date(), 60_000, 1000))?.reviewRepoId).toBe("repo-api");
  });

  it("is paused for good when deleted: unsuspending its installation leaves it paused", async () => {
    await enrolled(1, [{ name: "api", githubId: 501 }]);
    await deliver("repository", {
      action: "deleted",
      repository: { id: 501, full_name: "octo/api" },
    });
    expect((await repoOf("repo-api"))?.paused).toBe("deleted");
    await deliver("installation", {
      action: "unsuspend",
      installation: { account: { login: "octo" } },
    });
    expect((await repoOf("repo-api"))?.paused).toBe("deleted");
  });
});

describe("an installation suspended or uninstalled", () => {
  it("pauses every repository of its owner, and resumes them when unsuspended or installed again", async () => {
    const me = await enrolled(1, [
      { name: "api", githubId: 501 },
      { name: "web", githubId: 502 },
    ]);
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos("elsewhere"),
      accountId: me.id,
      platformRepoId: "900",
      fullName: "octopus/api",
    });
    const paused = async () =>
      (await me.data.list("reviewRepos"))
        .map((r) => [r.fullName, r.paused])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    await deliver("installation", {
      action: "suspend",
      installation: { account: { login: "Octo" } },
    });
    expect(await paused()).toEqual([
      ["octo/api", "suspended"],
      ["octo/web", "suspended"],
      ["octopus/api", null],
    ]);
    await deliver("installation", {
      action: "unsuspend",
      installation: { account: { login: "octo" } },
    });
    expect((await paused()).every(([, p]) => p === null)).toBe(true);

    await deliver("installation", {
      action: "deleted",
      installation: { account: { login: "octo" } },
    });
    expect(await paused()).toEqual([
      ["octo/api", "uninstalled"],
      ["octo/web", "uninstalled"],
      ["octopus/api", null],
    ]);
    await deliver("installation", {
      action: "created",
      installation: { account: { login: "octo" }, repository_selection: "selected" },
      repositories: [{ id: 502 }],
    });
    expect(await paused()).toEqual([
      ["octo/api", "uninstalled"],
      ["octo/web", null],
      ["octopus/api", null],
    ]);
  });
});

describe("a GitLab project renamed while its hooks were down", () => {
  it("is followed by the daily reconciliation, which reads its path by id", async () => {
    const a = await account(1, [{ name: "group/app", platform: "gitlab" }]);
    const projectId = `gh-${a.repo("group/app")}`;
    const reads: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (
        url.origin === GITLAB &&
        url.pathname === `/api/v4/projects/${encodeURIComponent(projectId)}`
      ) {
        return Response.json({ id: 1, path_with_namespace: "team/app" });
      }
      const listed = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)\/merge_requests$/);
      if (url.origin === GITLAB && listed?.[1]) {
        reads.push(decodeURIComponent(listed[1]));
        return Response.json([]);
      }
      return new Response("{}", { status: 404 });
    });
    await hourly();
    expect((await a.data.list("reviewRepos"))[0]?.fullName).toBe("team/app");
    // Read by its new path at once.
    expect(reads).toEqual(["team/app", "team/app"]);
  });
});

describe("a GitHub repository renamed while its webhooks were down", () => {
  it("is followed once its old name stops answering, and read by its new one on the retry", async () => {
    const a = await account(1, [{ name: "octo/api" }]);
    const repoId = `gh-${a.repo("octo/api")}`;
    const reads: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === `/repositories/${encodeURIComponent(repoId)}`) {
        return Response.json({ id: 1, full_name: "octo/core" });
      }
      const listed = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
      if (listed?.[1]) {
        reads.push(listed[1]);
        // GitHub answers an old name with a redirect, which is not followed.
        return listed[1] === "octo/core" ? Response.json([]) : new Response(null, { status: 301 });
      }
      return new Response("{}", { status: 404 });
    });
    await hourly();
    expect((await a.data.list("reviewRepos"))[0]?.fullName).toBe("octo/core");
    expect(reads).toEqual(["octo/api", "octo/api", "octo/core", "octo/core"]);
  });
});

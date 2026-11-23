import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import { claimBuild, GRAPH_HISTORY_DAYS, pruneGraphBuilds } from "../src/db/graphs.js";
import * as schema from "../src/db/schema.js";
import { type Scoped, scoped } from "../src/db/scoped.js";
import { gunzip, gzipBase64 } from "../src/graph/gzip.js";
import { runNextBuild } from "../src/graph/runner.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { github } from "../src/platforms/github.js";
import { saveToken } from "../src/platforms/links.js";
import { githubClientOf } from "../src/platforms/registry.js";
import { DAY } from "../src/time.js";
import { C1, C2, C3, fakeBuilder, repoFake } from "./graph-fakes.js";

// The build queue and its runner, without the worker: claims, one commit at
// a time per repository, leases, retries, and what the history keeps.

const bindings = bindingsFrom({
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
});
const githubClient = githubClientOf(bindings);
if (!githubClient) throw new Error("the test bindings configure GitHub");
const githubPlatform = github(githubClient);
const platforms = [githubPlatform];
const LEASE = 60_000;

let dir: string;
let host: Awaited<ReturnType<typeof openHost>>;
let data: Scoped;
let repoId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-graph-builds-"));
  host = await openHost({
    databaseUrl: `file:${join(dir, "builds.db")}`,
    bindings,
    migrations: resolve("migrations"),
  });
});
afterAll(async () => {
  host.close();
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await host.db.delete(schema.accounts);
  const account = await upsertAccount(host.db, githubIdentity(1), "octo");
  data = scoped(host.db, account.id);
  await saveToken(data, bindings, githubPlatform, { access_token: "ghu_1" });
  repoId =
    (await data.graphs.addRepo(
      {
        platform: "github",
        host: "github.com",
        platformRepoId: "11",
        fullName: "Octo/API",
        branch: "main",
      },
      10,
    )) ?? "";
});

const at = (ms: number) => new Date(Date.UTC(2026, 10, 21) + ms);
const stateOf = async () =>
  Object.fromEntries((await data.find("graphBuilds", {})).map((b) => [b.commit, b.state]));
const run = (builder = fakeBuilder().builder, now = at(0)) =>
  runNextBuild({ db: host.db, env: bindings, platforms, builder, leaseMs: LEASE, now: () => now });

describe("claiming a build", () => {
  it("takes a repository's newest queued commit and supersedes the older ones", async () => {
    for (const c of [C1, C2, C3]) await data.graphs.queueBuild(repoId, c);
    const claimed = await claimBuild(host.db, at(0), LEASE);
    expect(claimed).toMatchObject({ commit: C3, attempts: 1 });
    expect(await stateOf()).toEqual({ [C1]: "superseded", [C2]: "superseded", [C3]: "running" });
  });

  it("runs one build of a repository at a time, until its lease lapses", async () => {
    await data.graphs.queueBuild(repoId, C1);
    const first = await claimBuild(host.db, at(0), LEASE);
    await data.graphs.queueBuild(repoId, C2);
    expect(await claimBuild(host.db, at(1_000), LEASE)).toBeUndefined();
    // The first run died: after its lease both are queued again, and the newest wins.
    const second = await claimBuild(host.db, at(LEASE + 1), LEASE);
    expect(second).toMatchObject({ commit: C2 });
    expect(await stateOf()).toMatchObject({ [C1]: "superseded" });
    // The dead run's late result is not kept over the newer claim.
    const late = {
      content: await gzipBase64("{}"),
      files: 0,
      parsed: 0,
      reused: 0,
      skipped: 0,
      truncated: false,
    };
    expect(await data.graphs.finishBuild(first?.id ?? "", 1, late, at(LEASE + 2))).toBe(false);
    expect(await data.list("graphChunks")).toEqual([]);
  });

  it("keeps a graph of several pieces whole, and without history only the newest", async () => {
    // Random bytes compress little: the graph is kept in more than one piece.
    const big = Buffer.from(crypto.getRandomValues(new Uint8Array(65_536))).toString("hex");
    const text = JSON.stringify({ filler: big.repeat(16) });
    const counts = { files: 1, parsed: 1, reused: 0, skipped: 0, truncated: false };
    for (const [commit, graph, history] of [
      [C1, text, true],
      [C2, "{}", true],
      [C3, text, false],
    ] as const) {
      await data.graphs.queueBuild(repoId, commit);
      const build = await claimBuild(host.db, new Date(), LEASE);
      const built = { content: await gzipBase64(graph), ...counts };
      expect(await data.graphs.finishBuild(build?.id ?? "", 1, built, new Date(), history)).toBe(
        true,
      );
    }
    const pieces = await data.list("graphChunks");
    expect(pieces.map((p) => p.seq).sort()).toEqual([0, 1]);
    expect(new Set(pieces.map((p) => p.buildId)).size).toBe(1);
    const kept = await data.graphs.newestGraph(repoId);
    expect(kept?.commit).toBe(C3);
    expect(await gunzip(kept?.content ?? new Uint8Array())).toBe(text);
    // An older build's graph went with the history; its record stays.
    expect(await data.graphs.newestGraph(repoId, C1)).toBeUndefined();
    expect(await stateOf()).toMatchObject({ [C1]: "done", [C2]: "done", [C3]: "done" });
  });

  it("gives each build to one of two runners claiming at once", async () => {
    await data.graphs.queueBuild(repoId, C1);
    const both = await Promise.all([
      claimBuild(host.db, at(0), LEASE),
      claimBuild(host.db, at(0), LEASE),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });
});

describe("running a build", () => {
  it("retries a tree the platform failed to answer, later each time, then gives up", async () => {
    const fake = repoFake({});
    await data.graphs.queueBuild(repoId, C1);
    expect(await run(undefined, at(0))).toBe(true);
    const [first] = await data.find("graphBuilds", {});
    expect(first).toMatchObject({ state: "queued", attempts: 1, error: "tree_unreadable" });
    expect(await run(undefined, at(1_000))).toBe(false);
    const firstRetry = first?.notBefore ?? at(0);
    await run(undefined, firstRetry);
    const [second] = await data.find("graphBuilds", {});
    const secondWait = (second?.notBefore?.getTime() ?? 0) - firstRetry.getTime();
    expect(secondWait).toBe(2 * (firstRetry.getTime() - at(0).getTime()));
    await run(undefined, second?.notBefore ?? at(0));
    expect(await data.find("graphBuilds", {})).toMatchObject([
      { state: "failed", attempts: 3, error: "tree_unreadable" },
    ]);
    expect(fake.fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up at once without the account's platform token", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    await data.removeWhere("platformLinks", {});
    await data.graphs.queueBuild(repoId, C1);
    await run();
    expect(await data.find("graphBuilds", {})).toMatchObject([
      { state: "failed", attempts: 1, error: "unlinked" },
    ]);
  });

  it("aborts a build that outlives its lease, and records it for a retry", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    await data.graphs.queueBuild(repoId, C1);
    const hanging = fakeBuilder({ hang: true });
    await runNextBuild({
      db: host.db,
      env: bindings,
      platforms,
      builder: hanging.builder,
      leaseMs: 50,
    });
    expect(await data.find("graphBuilds", {})).toMatchObject([
      { state: "queued", error: "build_failed" },
    ]);
  });

  it("records a lease that lapses while the tree is read as the build's failure", async () => {
    await data.graphs.queueBuild(repoId, C1);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    await runNextBuild({
      db: host.db,
      env: bindings,
      platforms,
      builder: fakeBuilder().builder,
      leaseMs: 50,
    });
    expect(await data.find("graphBuilds", {})).toMatchObject([
      { state: "queued", error: "build_failed" },
    ]);
  });
});

describe("the graph history", () => {
  async function built(commit: string, finishedAt: Date) {
    await data.graphs.queueBuild(repoId, commit);
    const [row] = await data.find("graphBuilds", { commit });
    await host.db
      .update(schema.graphBuilds)
      .set({ state: "done", createdAt: finishedAt, finishedAt })
      .where(eq(schema.graphBuilds.id, row?.id ?? ""));
  }

  it("keeps each repository's newest graph however old, and recent ones", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (GRAPH_HISTORY_DAYS + 1) * DAY);
    await built(C1, new Date(old.getTime() - DAY));
    await built(C2, old);
    expect(await pruneGraphBuilds(host.db, true, now)).toBe(1);
    expect(Object.keys(await stateOf())).toEqual([C2]);
    await built(C3, now);
    expect(await pruneGraphBuilds(host.db, true, now)).toBe(1);
    expect(Object.keys(await stateOf())).toEqual([C3]);
  });

  it("is deleted whole when the deployment keeps no graphs", async () => {
    await built(C1, new Date());
    expect(await pruneGraphBuilds(host.db, false)).toBe(1);
    expect(await stateOf()).toEqual({});
  });
});

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { scoped } from "../src/db/scoped.js";
import { remoteGraphs } from "../src/graph/remote.js";
import { type Exec, spawnExec } from "../src/node/checkout.js";
import { engineGraphParser } from "../src/node/engine-graph.js";
import { runRunner } from "../src/node/remote-runner.js";
import { serverGraphs } from "../src/node/runner-graphs.js";
import type { GraphRepoView, ImpactView } from "../src/shared/index.js";
import { C1, C2, repoFake } from "./graph-fakes.js";
import { bindings, graphServer, ORIGIN, SECRET, type Server } from "./graph-server.js";

// Code graphs where the server neither builds nor reads one (the Worker):
// a remote runner builds each queued graph from a clone and sends it to be
// kept, gives a review the graph, and sends what its pull request reaches.
// The clone and the graph are real: git on a repository made here, and the
// engine's parser.

const TOKEN = "runner-token-of-at-least-32-characters";
const PRICE = ["export function price(amount: number): number {", "  return amount * 2;", "}"].join(
  "\n",
);
const CART = [
  'import { price } from "./price";',
  "export function cart(items: number[]): number {",
  "  return items.reduce((sum, item) => sum + price(item), 0);",
  "}",
].join("\n");

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-remote-graphs-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "push.negotiate=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

/** A repository on disk that stands for GitHub's Octo/API; commit() pushes to its main. */
async function origin(root: string) {
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  await mkdir(work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  return {
    bare,
    async commit(files: Record<string, string>): Promise<string> {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), text);
      }
      git(work, "add", "--all");
      git(work, "commit", "--quiet", "--message", "change");
      git(work, "push", "--quiet", bare, "main");
      return git(work, "rev-parse", "HEAD");
    },
  };
}

let s: Server;
let repo: Awaited<ReturnType<typeof origin>>;
let accountId: string;
let auth: Record<string, string>;
let call: (path: string, init?: RequestInit) => Promise<Response>;
beforeEach(async () => {
  const root = join(dir, String(n++));
  await mkdir(root);
  s = await graphServer(root, "cloud.db", "off");
  repo = await origin(root);
  const app = createApp({
    openDb: () => s.host.db,
    clientAddress: () => "test",
    ...(remoteGraphs({}) ? { graphs: remoteGraphs({}) } : {}),
    githubWebhookSecret: SECRET,
    autoReview: { kick: () => {}, remote: true },
    bots: { forRepo: async () => ({ token: "ghs_bot", login: "ocra-review[bot]" }) },
    runnerToken: TOKEN,
  } as Parameters<typeof createApp>[0]);
  call = async (path, init) => app.fetch(new Request(ORIGIN + path, init), bindings);
  const me = await s.signIn(1);
  accountId = me.account.id;
  auth = me.auth;
});
afterEach(() => s.host.close());

const data = () => scoped(s.host.db, accountId);
const asRunner = (path: string, json: unknown) =>
  call(`/api/runner/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });

/** Adds Octo/API to the account's graphs and queues the commit's build. */
async function keep(commit: string): Promise<string> {
  const id = await data().graphs.addRepo(
    {
      platform: "github",
      host: "github.com",
      platformRepoId: "11",
      fullName: "Octo/API",
      branch: "main",
      webhookSecretHash: null,
      consentedAt: null,
    },
    5,
  );
  await data().graphs.queueBuild(id ?? "", commit);
  return id ?? "";
}

/** A runner on this machine, its clones made from the repository on disk, until one job ended. */
async function runOnce(cliCode = 0): Promise<string[][]> {
  const seen: string[][] = [];
  const stop = new AbortController();
  const exec: Exec = async (command, args, options) => {
    seen.push([command, ...args]);
    if (command !== "git") return { code: cliCode };
    const local = args.map((a) => (a === "https://github.com/Octo/API.git" ? repo.bare : a));
    return spawnExec("git", local, options);
  };
  let ended = false;
  await runRunner(
    {
      server: ORIGIN,
      token: TOKEN,
      name: "mini",
      version: "0.15.0",
      exec,
      cli: "/opt/ocra/main.js",
      pollMs: 5,
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        // The runner asks again after its report: that is when the test ends it.
        if (ended && url.endsWith("/claim")) stop.abort();
        const res = await call(url.slice(ORIGIN.length), init);
        if (/\/(settle|builds\/[^/]+)$/.test(url)) ended = true;
        return res;
      },
    },
    stop.signal,
  );
  return seen;
}

const graphOf = async (repoId: string) => {
  const res = await call(`/api/graphs/repos/${repoId}/graph`, {
    headers: { ...auth, "accept-encoding": "gzip" },
  });
  expect(res.headers.get("content-encoding")).toBe("gzip");
  return {
    commit: res.headers.get("x-ocra-graph-commit"),
    graph: engineGraphParser(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()),
  };
};

describe("a queued graph build on a server with remote runners", () => {
  it("is given only to a runner that builds graphs", async () => {
    await keep(await repo.commit({ "src/price.ts": PRICE }));
    const plain = await asRunner("claim", { name: "old", version: "0.14.0" });
    expect(await plain.json()).toEqual({ assignment: null });
    const res = await asRunner("claim", { name: "mini", version: "0.15.0", graphs: true });
    expect(await res.json()).toMatchObject({
      assignment: null,
      graph: {
        attempts: 1,
        repo: { platform: "github", url: "https://github.com", fullName: "Octo/API" },
        bot: { token: "ghs_bot" },
      },
    });
  });

  it("is built from a clone and kept, then updated from the kept graph", async () => {
    const first = await repo.commit({ "src/price.ts": PRICE, "src/cart.ts": CART });
    const repoId = await keep(first);
    const ran = await runOnce();
    expect(ran[0]).toEqual(expect.arrayContaining(["clone", "--no-checkout"]));
    const [build] = await data().find("graphBuilds", {});
    expect(build).toMatchObject({ state: "done", commit: first, files: 2, parsed: 2, reused: 0 });
    const kept = await graphOf(repoId);
    expect(kept.commit).toBe(first);
    expect([...(kept.graph?.files.keys() ?? [])].sort()).toEqual(["src/cart.ts", "src/price.ts"]);

    const second = await repo.commit({ "src/price.ts": PRICE.replace("* 2", "* 3") });
    await data().graphs.queueBuild(repoId, second);
    await runOnce();
    expect(await data().find("graphBuilds", { commit: second })).toMatchObject([
      { state: "done", files: 2, parsed: 1, reused: 1 },
    ]);
    expect((await graphOf(repoId)).commit).toBe(second);
    // The server keeps one graph of a repository: the first build's went.
    expect(new Set((await data().list("graphChunks")).map((c) => c.buildId)).size).toBe(1);
    const listed = (await (await call("/api/graphs/repos", { headers: auth })).json()) as {
      repos: GraphRepoView[];
    };
    expect(listed.repos[0]?.latest).toMatchObject({ state: "done", commit: second, files: 2 });
  });

  it("is given up when the bot cannot reach the repository's commit", async () => {
    await keep(C1);
    await repo.commit({ "src/price.ts": PRICE });
    await runOnce();
    expect(await data().find("graphBuilds", {})).toMatchObject([
      { state: "queued", error: "clone_failed", attempts: 1 },
    ]);
  });

  it("gives up a graph larger than the server keeps, which reads no body past it", async () => {
    const commit = await repo.commit({ "src/price.ts": PRICE });
    const repoId = await keep(commit);
    const { graph: build } = (await (
      await asRunner("claim", { name: "mini", version: "0.15.0", graphs: true })
    ).json()) as { graph: { id: string } };
    // Random bytes in hex gzip to half their length: over 8 MB here.
    const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(65_536))).toString("hex");
    const graphs = serverGraphs(ORIGIN, TOKEN, (input, init) =>
      call(String(input).slice(ORIGIN.length), init),
    );
    await graphs.finish(
      { id: build.id, accountId, attempts: 1 },
      { graph: noise.repeat(140), commit, files: 1, parsed: 1, reused: 0, skipped: 0 },
    );
    expect(await data().find("graphBuilds", {})).toMatchObject([
      { state: "failed", error: "too_large" },
    ]);
    expect(await data().graphs.newestGraph(repoId)).toBeUndefined();
  });
});

describe("a hosted review of a repository whose graph is kept", () => {
  const impactOf = async (repoId: string) =>
    (await (
      await call(`/api/graphs/repos/${repoId}/impact?pull=7`, { headers: auth })
    ).json()) as ImpactView;

  it("reads the graph and leaves what the pull request reaches", async () => {
    const head = await repo.commit({ "src/price.ts": PRICE, "src/cart.ts": CART });
    repoFake({}, head, {
      7: {
        base: C1,
        head: C2,
        files: [{ path: "src/price.ts", status: "modified", patch: "@@ -2,1 +2,1 @@\n-x\n+y" }],
      },
    });
    const jobs = data().autoReview;
    const reviewed = await jobs.enroll(
      { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
      100,
    );
    await jobs.queue(reviewed ?? "", 7, C2, new Date());

    const ran = await runOnce();
    // A reviewed repository starts keeping its graph with its first review.
    const [kept] = await data().find("graphRepos", {});
    expect(kept).toMatchObject({ fullName: "Octo/API", branch: "main" });
    expect(await data().find("graphBuilds", {})).toMatchObject([{ state: "queued", commit: head }]);
    const cli = ran.find((command) => command[0] !== "git") ?? [];
    expect(cli[cli.indexOf("--graph") + 1]).toMatch(/graph\.json$/);

    const view = await impactOf(kept?.id ?? "");
    expect(view.pull).toMatchObject({ base: C1, head: C2, files: 1 });
    expect(view.graph).toMatchObject({ commit: head, current: false, files: 2 });
    expect(view.symbols).toMatchObject([
      {
        name: "price",
        path: "src/price.ts",
        change: "body",
        useCount: 2,
        uses: [
          { path: "src/cart.ts", line: 1, code: 'import { price } from "./price";' },
          { path: "src/cart.ts", line: 3, within: "cart" },
        ],
      },
    ]);
  });

  it("reads a pull request's impact from the graph of its base, not of the branch's head", async () => {
    const base = await repo.commit({ "src/price.ts": PRICE, "src/cart.ts": CART });
    const head = await repo.commit({ "src/later.ts": "export const later = 1;\n" });
    repoFake({}, head, {
      7: {
        base,
        head: C2,
        files: [{ path: "src/price.ts", status: "modified", patch: "@@ -2,1 +2,1 @@\n-x\n+y" }],
      },
    });
    const jobs = data().autoReview;
    const reviewed = await jobs.enroll(
      { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
      100,
    );
    await jobs.queue(reviewed ?? "", 7, C2, new Date());

    await runOnce();

    const [kept] = await data().find("graphRepos", {});
    const view = await impactOf(kept?.id ?? "");
    expect(view.graph).toMatchObject({ commit: base, current: true, files: 2 });
    expect(view.symbols).toMatchObject([{ name: "price", useCount: 2 }]);
  });

  it("says the impact waits for a review until one ran", async () => {
    const repoId = await keep(await repo.commit({ "src/price.ts": PRICE }));
    expect(await impactOf(repoId)).toEqual({
      pull: null,
      graph: null,
      build: { state: "queued", commit: expect.any(String), error: null },
      symbols: [],
      more: 0,
    });
    await runOnce();
    expect(await impactOf(repoId)).toMatchObject({ pull: null, graph: null, build: null });
  });
});

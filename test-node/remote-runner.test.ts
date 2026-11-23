import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { runRunner } from "../src/node/remote-runner.js";
import type { Exec } from "../src/node/review-runner.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// A remote runner (docs/runner.md): the server queues and prepares a hosted
// job, a runner that proves itself with the deployment's token takes it,
// runs it on its own machine and reports how it went.

const TOKEN = "runner-token-of-at-least-32-characters";

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-remote-runner-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
let accountId: string;
let auth: Record<string, string>;
beforeEach(async () => {
  s = await graphServer(dir, `remote-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    tokens: { forRepo: async () => ({ token: "ghs_bot", login: "ocra-review[bot]" }) },
    workers: 0,
    runnerToken: TOKEN,
  });
  const me = await s.signIn(1);
  accountId = me.account.id;
  auth = me.auth;
  const jobs = scoped(s.host.db, accountId).autoReview;
  const repo = await jobs.enroll(
    { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
    100,
  );
  await jobs.queue(repo ?? "", 7, C1, new Date());
});
afterEach(() => s.host.close());

const asRunner = (path: string, json: unknown, token = TOKEN) =>
  s.call(`/api/runner/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    json,
  });
const hello = { name: "mini", version: "0.12.0" };
const job = async () => (await s.host.db.select().from(schema.reviewJobs))[0];
const sessions = async () =>
  (await scoped(s.host.db, accountId).list("sessions")).filter((x) => x.label === "auto review");

type Seen = { args: string[][]; credentials?: Record<string, unknown>; env?: unknown };

/** Takes jobs with a fake machine whose CLI exits with cliCode, until the first job ended. */
async function runOnce(cliCode: number): Promise<Seen> {
  const seen: Seen = { args: [] };
  const stop = new AbortController();
  const exec: Exec = async (command, args, options) => {
    seen.args.push([command, ...args]);
    if (command === "git") {
      await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
      return { code: 0 };
    }
    seen.credentials = JSON.parse(
      await readFile(join(options.env.XDG_CONFIG_HOME ?? "", "ocra", "credentials.json"), "utf8"),
    );
    seen.env = options.env;
    return { code: cliCode };
  };
  let settled = false;
  await runRunner(
    {
      server: ORIGIN,
      token: TOKEN,
      ...hello,
      exec,
      cli: "/opt/ocra/main.js",
      pollMs: 5,
      fetch: async (input, init) => {
        const res = await s.host.fetch(new Request(input, init));
        // The runner asks again after its report: that is when the test ends it.
        if (settled) stop.abort();
        if (String(input).endsWith("/settle")) settled = true;
        return res;
      },
    },
    stop.signal,
  );
  return seen;
}

describe("a remote runner's calls", () => {
  it("are refused without the deployment's runner token", async () => {
    expect((await asRunner("claim", hello, "another-token-of-at-least-32-characters")).status).toBe(
      401,
    );
    expect((await s.call("/api/runner/claim", { method: "POST", json: hello })).status).toBe(401);
    expect((await asRunner("settle", {}, "")).status).toBe(401);
    expect((await job())?.state).toBe("queued");
  });

  it("claim the next job with what its run needs, once", async () => {
    const res = await asRunner("claim", hello);
    expect(res.status).toBe(200);
    const { assignment } = (await res.json()) as { assignment: Record<string, unknown> };
    expect(assignment).toMatchObject({
      kind: "review",
      attempts: 1,
      accountId,
      repo: { platform: "github", url: "https://github.com", fullName: "Octo/API" },
      bot: { token: "ghs_bot", login: "ocra-review[bot]" },
      cloudUrl: ORIGIN,
      credentials: { server: ORIGIN, login: "user-1" },
      uploadSalt: expect.stringMatching(/^[0-9a-f]{64}$/),
      args: ["review", "--pr", "7", "--repo", "Octo/API", "--publish", "--no-repo-config"],
      config: { github: { botLogin: "ocra-review[bot]" } },
      ok: [0, 1, 3],
    });
    expect((await job())?.state).toBe("running");
    expect(await (await asRunner("claim", hello)).json()).toEqual({ assignment: null });
  });

  it("record a report only for the attempt that holds the job", async () => {
    const { assignment } = (await (await asRunner("claim", hello)).json()) as {
      assignment: { id: string };
    };
    const ref = { kind: "review", id: assignment.id, accountId, attempts: 2, failure: null };
    expect((await asRunner("settle", ref)).status).toBe(200);
    expect((await job())?.state).toBe("running");
    expect((await asRunner("settle", { ...ref, attempts: 1 })).status).toBe(200);
    expect((await job())?.state).toBe("done");
  });
});

describe("a remote runner", () => {
  it("runs the job on its machine, reports it done and leaves no session", async () => {
    const seen = await runOnce(1);
    expect(seen.args[0]?.slice(0, 2)).toEqual(["git", "clone"]);
    expect(seen.args[1]?.slice(1, 9)).toEqual([
      "/opt/ocra/main.js",
      "review",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--publish",
      "--no-repo-config",
    ]);
    expect(seen.credentials).toMatchObject({ server: ORIGIN, login: "user-1" });
    expect(seen.env).toMatchObject({ OCRA_CLOUD_URL: ORIGIN, GITHUB_TOKEN: "ghs_bot" });
    expect(seen.env).not.toHaveProperty("OCRA_RUNNER_TOKEN");
    expect(await job()).toMatchObject({ state: "done", error: null });
    expect(await sessions()).toEqual([]);
  });

  it("reports a failed run, which the server queues again for later", async () => {
    await runOnce(2);
    const failed = await job();
    expect(failed).toMatchObject({ state: "queued", error: "review_failed", attempts: 1 });
    expect(failed?.notBefore?.getTime()).toBeGreaterThan(Date.now());
    expect(await sessions()).toEqual([]);
  });

  it("is shown to the console with when it last asked for work", async () => {
    await asRunner("claim", hello);
    const res = await s.call("/api/auto-review/runners", { headers: auth });
    expect(await res.json()).toMatchObject({
      remote: true,
      runners: [{ name: "mini", version: "0.12.0" }],
    });
  });
});

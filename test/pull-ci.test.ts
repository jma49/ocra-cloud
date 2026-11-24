import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { PullCiLogView, PullCiRerunAnswer, PullCiView } from "../src/shared/index.js";
import { db, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// A pull request's CI panel, read and run again live as the user.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const REPO = "https://api.github.com/repos/octo/api";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;
const LAB = `platform=gitlab&repo=${encodeURIComponent("Group/Sub/Project")}&number=4`;

type Route = (req: Request) => Response | Promise<Response>;
type Seen = { method: string; url: string; authorization: string | null };

function platform(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  githubFake({
    extra: (req) => {
      const path = req.url.split("?")[0];
      const route = routes[`${req.method} ${path}`] ?? routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.get("authorization"),
      });
      return route(req);
    },
  });
  return seen;
}

const checkRun = (id: number, name: string, extra = {}) => ({
  id,
  name,
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  started_at: "2026-11-24T10:00:00Z",
  completed_at: "2026-11-24T10:02:05Z",
  html_url: `https://github.com/octo/api/runs/${id}`,
  details_url: `https://ci.example.com/${id}`,
  app: { slug: "github-actions" },
  ...extra,
});

const pull = { [`GET ${REPO}/pulls/7`]: () => Response.json({ head: { sha: HEAD } }) };

const post = (send: (p: string, i?: RequestInit) => Promise<Response>, body: unknown) =>
  send("/api/pulls/ci/rerun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a GitHub pull request's CI", () => {
  it("lists the head's check runs and statuses, failed first, with the failed step", async () => {
    platform({
      ...pull,
      [`GET ${REPO}/commits/${HEAD}/check-runs`]: () =>
        Response.json({
          total_count: 4,
          check_runs: [
            checkRun(1, "lint"),
            checkRun(2, "test", { conclusion: "failure" }),
            checkRun(3, "build", { status: "in_progress", conclusion: null, completed_at: null }),
            checkRun(4, "codecov", { conclusion: "timed_out", app: { slug: "codecov" } }),
          ],
        }),
      [`GET ${REPO}/commits/${HEAD}/status`]: () =>
        Response.json({
          statuses: [
            {
              context: "deploy/preview",
              state: "error",
              target_url: "https://deploy.example.com/1",
              created_at: "2026-11-24T10:00:00Z",
              updated_at: "2026-11-24T10:00:30Z",
            },
          ],
        }),
      [`GET ${REPO}/actions/jobs/2`]: () =>
        Response.json({
          steps: [
            { name: "Set up job", conclusion: "success", number: 1 },
            { name: "Run npm test", conclusion: "failure", number: 3 },
          ],
        }),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci?platform=github&repo=octo/api&number=7");
    expect(res.status).toBe(200);
    const view = (await res.json()) as PullCiView;
    expect(view.head).toBe(HEAD);
    expect(view.jobs.map((j) => [j.name, j.state, j.source, j.rerunnable])).toEqual([
      ["codecov", "failed", "check_run", false],
      ["deploy/preview", "failed", "status", false],
      ["test", "failed", "github_actions", true],
      ["build", "pending", "github_actions", false],
      ["lint", "passed", "github_actions", true],
    ]);
    const test = view.jobs.find((j) => j.name === "test");
    expect(test).toMatchObject({ id: "2", failedStep: "Run npm test", durationSeconds: 125 });
    expect(view.jobs.find((j) => j.source === "status")).toMatchObject({ id: null, hasLog: false });
  });

  it("names what the fix loop's last round on this head did with a failed check", async () => {
    platform({
      ...pull,
      [`GET ${REPO}/commits/${HEAD}/check-runs`]: () =>
        Response.json({
          total_count: 2,
          check_runs: [
            checkRun(2, "test", { conclusion: "failure" }),
            checkRun(5, "lint", { conclusion: "failure" }),
          ],
        }),
      [`GET ${REPO}/commits/${HEAD}/status`]: () => Response.json({ statuses: [] }),
      [`GET ${REPO}/actions/jobs/2`]: () => Response.json({ steps: [] }),
      [`GET ${REPO}/actions/jobs/5`]: () => Response.json({ steps: [] }),
    });
    const a = await signInWithGithub();
    const [account] = await db.select().from(schema.accounts);
    const data = scoped(db, account?.id ?? "");
    await data.insert("reviewRepos", { ...rows.reviewRepos("r"), fullName: "octo/api" });
    await data.insert("mendJobs", {
      id: "m",
      reviewRepoId: "r",
      number: 7,
      checksHead: "c".repeat(40),
      checkItems: [{ check: "test", outcome: "needs_human", reason: null, cause: null }],
    });
    const read = async () =>
      (await (
        await a.send("/api/pulls/ci?platform=github&repo=octo/api&number=7")
      ).json()) as PullCiView;
    expect((await read()).jobs.map((j) => j.mend)).toEqual([null, null]);
    await data.update("mendJobs", "m", { checksHead: HEAD });
    const view = await read();
    expect(view.jobs.map((j) => [j.name, j.mend?.outcome ?? null])).toEqual([
      ["lint", null],
      ["test", "needs_human"],
    ]);
  });

  it("answers the end of an Actions job's log, cleaned and redacted, read past the redirect without the token", async () => {
    const lines = Array.from(
      { length: 300 },
      (_, i) => `2026-11-24T10:00:00.1234567Z \u001b[31mline ${i}\u001b[0m`,
    );
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const seen = platform({
      [`GET ${REPO}/check-runs/2`]: () =>
        Response.json(checkRun(2, "test", { conclusion: "failure" })),
      [`GET ${REPO}/actions/jobs/2/logs`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://logs.example.net/job-2?sig=x" },
        }),
      "GET https://logs.example.net/job-2": () =>
        new Response(`${lines.join("\n")}\ntoken ${secret}\n`),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci/log?platform=github&repo=octo/api&number=7&job=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = (await res.json()) as PullCiLogView;
    expect(view).toMatchObject({ job: "2", name: "test", source: "job_log", redacted: true });
    const shown = view.log.split("\n");
    expect(shown).toHaveLength(200);
    expect(shown[0]).toBe("line 101");
    expect(view.log).not.toContain("\u001b");
    expect(view.log).not.toContain(secret);
    const blob = seen.find((s) => s.url.startsWith("https://logs.example.net/"));
    expect(blob?.authorization).toBeNull();
  });

  it("keeps the failed step's part of an Actions log, not the steps after it", async () => {
    const at = (n: number) => `2026-11-24T03:54:${String(n % 60).padStart(2, "0")}.1234567Z`;
    const log = [
      `${at(0)} ##[group]Run actions/checkout@v4`,
      `${at(1)} Syncing repository: octo/api`,
      `${at(2)} ##[endgroup]`,
      `${at(3)} ##[group]Run npm run typecheck`,
      `${at(4)} npm run typecheck`,
      `${at(5)} ##[endgroup]`,
      `${at(6)} src/refund.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `${at(7)} ##[error]Process completed with exit code 2.`,
      `${at(8)} ##[group]Run npm run build`,
      ...Array.from({ length: 300 }, (_, i) => `${at(i)} dist/assets/chunk-${i}.js  1.2 kB`),
      `${at(9)} Post job cleanup.`,
      `${at(10)} [command]/usr/bin/git version`,
      `${at(11)} Cleaning up orphan processes`,
    ].join("\n");
    platform({
      [`GET ${REPO}/check-runs/2`]: () =>
        Response.json(checkRun(2, "verify", { conclusion: "failure" })),
      [`GET ${REPO}/actions/jobs/2/logs`]: () => new Response(log),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci/log?platform=github&repo=octo/api&number=7&job=2");
    const view = (await res.json()) as PullCiLogView;
    expect(view.log.split("\n")).toEqual([
      "##[group]Run npm run typecheck",
      "npm run typecheck",
      "##[endgroup]",
      "src/refund.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "##[error]Process completed with exit code 2.",
    ]);
  });

  it("answers what another app's check reported, and its address", async () => {
    platform({
      [`GET ${REPO}/check-runs/4`]: () =>
        Response.json(
          checkRun(4, "codecov", {
            conclusion: "failure",
            app: { slug: "codecov" },
            output: { title: "Coverage fell", summary: "80% < 85%", text: null },
          }),
        ),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci/log?platform=github&repo=octo/api&number=7&job=4");
    const view = (await res.json()) as PullCiLogView;
    expect(view).toMatchObject({
      source: "check_output",
      log: "Coverage fell\n80% < 85%",
      url: "https://github.com/octo/api/runs/4",
    });
  });

  it("falls back to what an Actions job reported when its log is refused", async () => {
    platform({
      [`GET ${REPO}/check-runs/2`]: () =>
        Response.json(
          checkRun(2, "test", {
            conclusion: "failure",
            output: { title: "Process completed with exit code 1", summary: null, text: null },
          }),
        ),
      [`GET ${REPO}/actions/jobs/2/logs`]: () => new Response(null, { status: 403 }),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci/log?platform=github&repo=octo/api&number=7&job=2");
    const view = (await res.json()) as PullCiLogView;
    expect(view).toMatchObject({
      source: "check_output",
      log: "Process completed with exit code 1",
    });
  });

  it("refuses a job id that is not a number", async () => {
    platform({});
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/ci/log?platform=github&repo=octo/api&number=7&job=..%2F1");
    expect(res.status).toBe(404);
  });

  it("reruns the head's failed workflow runs, and records it", async () => {
    const seen = platform({
      ...pull,
      [`GET ${REPO}/actions/runs`]: () =>
        Response.json({
          workflow_runs: [
            { id: 11, head_sha: HEAD, status: "completed", conclusion: "failure" },
            { id: 12, head_sha: HEAD, status: "completed", conclusion: "success" },
            { id: 13, head_sha: HEAD, status: "in_progress", conclusion: null },
          ],
        }),
      [`POST ${REPO}/actions/runs/11/rerun-failed-jobs`]: () => new Response(null, { status: 201 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, { platform: "github", repo: "octo/api", number: 7, head: HEAD });
    expect((await res.json()) as PullCiRerunAnswer).toEqual({ outcome: "rerun", rerun: 1 });
    expect(seen.filter((s) => s.method === "POST").map((s) => s.url)).toEqual([
      `${REPO}/actions/runs/11/rerun-failed-jobs`,
    ]);
    const log = (await (await a.send("/api/audit")).json()) as {
      events: { kind: string; detail: unknown }[];
    };
    expect(log.events.find((e) => e.kind === "pull.checks_rerun")?.detail).toEqual({
      pull: "octo/api#7",
      head: HEAD,
      rerun: 1,
    });
  });

  it("refuses a stale head and reruns nothing", async () => {
    const seen = platform({ ...pull });
    const a = await signInWithGithub();
    const res = await post(a.send, {
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: "b".repeat(40),
    });
    expect((await res.json()) as PullCiRerunAnswer).toEqual({ outcome: "stale", rerun: 0 });
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("says refused when the App lacks Actions permission", async () => {
    platform({
      ...pull,
      [`GET ${REPO}/actions/runs`]: () =>
        Response.json({ message: "Resource not accessible" }, { status: 403 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, { platform: "github", repo: "octo/api", number: 7, head: HEAD });
    expect((await res.json()) as PullCiRerunAnswer).toEqual({ outcome: "refused", rerun: 0 });
  });

  it("reruns one Actions job, never another app's check", async () => {
    platform({
      ...pull,
      [`GET ${REPO}/check-runs/2`]: () =>
        Response.json(checkRun(2, "test", { conclusion: "failure" })),
      [`GET ${REPO}/check-runs/4`]: () =>
        Response.json(checkRun(4, "codecov", { app: { slug: "codecov" } })),
      [`POST ${REPO}/actions/jobs/2/rerun`]: () => new Response(null, { status: 201 }),
    });
    const a = await signInWithGithub();
    const one = await post(a.send, {
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: HEAD,
      job: "2",
    });
    expect((await one.json()) as PullCiRerunAnswer).toEqual({ outcome: "rerun", rerun: 1 });
    const other = await post(a.send, {
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: HEAD,
      job: "4",
    });
    expect((await other.json()) as PullCiRerunAnswer).toEqual({
      outcome: "not_rerunnable",
      rerun: 0,
    });
  });
});

describe("a GitLab merge request's CI", () => {
  const job = (id: number, name: string, status: string, extra = {}) => ({
    id,
    name,
    status,
    allow_failure: false,
    started_at: "2026-11-24T10:00:00Z",
    finished_at: "2026-11-24T10:01:00Z",
    duration: 60.4,
    web_url: `${GITLAB}/Group/Sub/Project/-/jobs/${id}`,
    failure_reason: status === "failed" ? "script_failure" : null,
    pipeline: { sha: HEAD },
    ...extra,
  });
  const lab = {
    [`GET ${PROJECT}/merge_requests/4`]: () => Response.json({ sha: HEAD }),
    [`GET ${PROJECT}/merge_requests/4/pipelines`]: () =>
      Response.json([
        { id: 90, sha: HEAD, web_url: `${GITLAB}/Group/Sub/Project/-/pipelines/90` },
        { id: 80, sha: "c".repeat(40) },
      ]),
    [`GET ${PROJECT}/pipelines/90/jobs`]: () =>
      Response.json([
        job(1, "unit", "failed"),
        job(2, "lint", "failed", { allow_failure: true }),
        job(3, "e2e", "running", { finished_at: null, duration: null }),
        job(4, "build", "success"),
      ]),
  };

  async function signedIn() {
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    return a;
  }

  it("lists the jobs of the newest pipeline on the head", async () => {
    platform(lab);
    const a = await signedIn();
    const view = (await (await a.send(`/api/pulls/ci?${LAB}`)).json()) as PullCiView;
    expect(view.pipeline).toEqual({ id: "90", url: `${GITLAB}/Group/Sub/Project/-/pipelines/90` });
    expect(view.jobs.map((j) => [j.name, j.state])).toEqual([
      ["unit", "failed"],
      ["e2e", "pending"],
      ["lint", "neutral"],
      ["build", "passed"],
    ]);
    expect(view.jobs[0]).toMatchObject({
      failureReason: "script_failure",
      durationSeconds: 60,
      rerunnable: true,
    });
  });

  it("answers a job's trace", async () => {
    platform({
      [`GET ${PROJECT}/jobs/1`]: () => Response.json(job(1, "unit", "failed")),
      [`GET ${PROJECT}/jobs/1/trace`]: () =>
        new Response("\u001b[0KRunning tests\r\nFAIL src/a.test.ts\r\n"),
    });
    const a = await signedIn();
    const view = (await (await a.send(`/api/pulls/ci/log?${LAB}&job=1`)).json()) as PullCiLogView;
    expect(view).toMatchObject({ source: "job_log", log: "Running tests\nFAIL src/a.test.ts" });
  });

  it("answers no log, with the job's address, when its trace is refused", async () => {
    platform({
      [`GET ${PROJECT}/jobs/1`]: () => Response.json(job(1, "unit", "failed")),
      [`GET ${PROJECT}/jobs/1/trace`]: () => new Response(null, { status: 403 }),
    });
    const a = await signedIn();
    const view = (await (await a.send(`/api/pulls/ci/log?${LAB}&job=1`)).json()) as PullCiLogView;
    expect(view).toMatchObject({
      source: "none",
      log: "",
      url: `${GITLAB}/Group/Sub/Project/-/jobs/1`,
    });
  });

  it("keeps a GitLab trace's script section, not the sections after it", async () => {
    const trace = [
      "\u001b[0KRunning with gitlab-runner 17.0.0",
      "section_start:1732420000:prepare_script\r\u001b[0K\u001b[0K\u001b[36;1mPreparing environment\u001b[0;m",
      "Running on runner-1",
      "section_end:1732420001:prepare_script\r\u001b[0K",
      'section_start:1732420002:step_script\r\u001b[0K\u001b[0K\u001b[36;1mExecuting "step_script" stage\u001b[0;m',
      "$ npm test",
      "FAIL src/refund.test.ts",
      "section_end:1732420003:step_script\r\u001b[0K",
      "section_start:1732420004:upload_artifacts_on_failure\r\u001b[0KUploading artifacts",
      ...Array.from({ length: 300 }, (_, i) => `coverage/file-${i}.html: found`),
      "section_end:1732420005:upload_artifacts_on_failure\r\u001b[0K",
      "\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m",
    ].join("\n");
    platform({
      [`GET ${PROJECT}/jobs/1`]: () => Response.json(job(1, "unit", "failed")),
      [`GET ${PROJECT}/jobs/1/trace`]: () => new Response(trace),
    });
    const a = await signedIn();
    const view = (await (await a.send(`/api/pulls/ci/log?${LAB}&job=1`)).json()) as PullCiLogView;
    expect(view.log).toContain("FAIL src/refund.test.ts");
    expect(view.log).not.toContain("coverage/file-");
    expect(view.log).not.toContain("Preparing environment");
  });

  it("retries the head's failed jobs, not those allowed to fail", async () => {
    const seen = platform({
      ...lab,
      [`POST ${PROJECT}/jobs/1/retry`]: () => Response.json({ id: 5 }, { status: 201 }),
    });
    const a = await signedIn();
    const res = await post(a.send, {
      platform: "gitlab",
      repo: "Group/Sub/Project",
      number: 4,
      head: HEAD,
    });
    expect((await res.json()) as PullCiRerunAnswer).toEqual({ outcome: "rerun", rerun: 1 });
    expect(seen.filter((s) => s.method === "POST").map((s) => s.url)).toEqual([
      `${PROJECT}/jobs/1/retry`,
    ]);
  });

  it("refuses a job of another head", async () => {
    platform({
      ...lab,
      [`GET ${PROJECT}/jobs/7`]: () =>
        Response.json(job(7, "old", "failed", { pipeline: { sha: "c".repeat(40) } })),
    });
    const a = await signedIn();
    const res = await post(a.send, {
      platform: "gitlab",
      repo: "Group/Sub/Project",
      number: 4,
      head: HEAD,
      job: "7",
    });
    expect((await res.json()) as PullCiRerunAnswer).toEqual({
      outcome: "not_rerunnable",
      rerun: 0,
    });
  });
});

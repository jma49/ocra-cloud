import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { HOUR } from "../src/time.js";
import { C1, C2, GITLAB, repoFake } from "./graph-fakes.js";
import { graphServer, type Server } from "./graph-server.js";

// The automation triggers after a merge request is queued, on a
// self-hosted server with the ocra bot: GitLab's merge request and pipeline
// hooks (merged, approved, out of draft, a label added, its pipeline
// failed) and the hourly run (stale) each run a rule once, writing as the
// bot on the project the hook's secret proves.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-automation-triggers-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const NOTES = `${GITLAB}/api/v4/projects/group%2Fapi/merge_requests/3/notes`;

let s: Server;
let notes: string[];
beforeEach(async () => {
  s = await graphServer(dir, `triggers-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api, gitlabBotToken: "glbot" },
    workers: 0,
  });
  notes = [];
  const fake = repoFake({ [C1]: {} });
  const inner = fake.fetch.getMockImplementation();
  fake.fetch.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.method === "POST" && req.url.includes("/merge_requests/")) {
      notes.push(
        `${req.url.replace(/\/notes$/, "")} ${((await req.json()) as { body: string }).body}`,
      );
      return Response.json({});
    }
    if (!inner) throw new Error("no fake");
    return inner(input, init);
  });
});
afterEach(async () => {
  await s.host.idle();
  s.host.close();
});

async function enrolled() {
  const { auth } = await s.signIn(1);
  const res = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: auth,
    json: { platform: "gitlab", fullName: "group/api" },
  });
  const { webhook } = (await res.json()) as { webhook: { secret: string } };
  const addRule = async (trigger: string, conditions: Record<string, unknown>) => {
    const added = await s.call("/api/automations/rules", {
      method: "POST",
      headers: auth,
      json: { name: trigger, trigger, conditions, actions: [{ kind: "comment", body: trigger }] },
    });
    expect(added.status).toBe(200);
  };
  const hook = async (kind: string, json: Record<string, unknown>) => {
    const res = await s.call("/api/auto-review/webhooks/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": kind, "x-gitlab-token": webhook.secret },
      json: { project: { id: 21, path_with_namespace: "group/api" }, ...json },
    });
    expect(res.status).toBe(202);
  };
  const mr = (attributes: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    hook("Merge Request Hook", {
      object_attributes: {
        iid: 3,
        last_commit: { id: C1 },
        title: "feat: parser",
        target_branch: "main",
        author_id: 9,
        ...attributes,
      },
      user: { id: 9, username: "mona" },
      labels: [],
      ...more,
    });
  const runs = async () =>
    (
      (await (await s.call("/api/automations/runs", { headers: auth })).json()) as {
        runs: { trigger: string; outcome: string }[];
      }
    ).runs;
  return { addRule, hook, mr, runs };
}

describe("a merge request's later events", () => {
  it("run the rules on them as the bot, once each", async () => {
    const { addRule, hook, mr, runs } = await enrolled();
    await addRule("ready_for_review", { authors: ["mona"] });
    await addRule("approved", { baseBranches: ["main"] });
    await addRule("labeled", { labels: ["urgent"] });
    await addRule("checks_failed", { title: "feat*" });
    await addRule("merged", {});
    await mr({ action: "open", draft: true });
    const ready = () =>
      mr({ action: "update" }, { changes: { draft: { previous: true, current: false } } });
    await ready();
    await ready();
    const attrs = {
      iid: 3,
      title: "feat: parser",
      target_branch: "main",
      author_id: 9,
      last_commit: { id: C1 },
    };
    const approve = (id: number, username: string) =>
      hook("Merge Request Hook", {
        object_attributes: { ...attrs, action: "approval" },
        user: { id, username },
      });
    await approve(9, "mona");
    await approve(10, "rita");
    await hook("Merge Request Hook", {
      object_attributes: { ...attrs, action: "approved" },
      user: { id: 10, username: "rita" },
    });
    const labels = (previous: string[], current: string[]) =>
      mr(
        { action: "update" },
        {
          changes: {
            labels: {
              previous: previous.map((title) => ({ title })),
              current: current.map((title) => ({ title })),
            },
          },
        },
      );
    await labels([], ["docs"]);
    await labels(["docs"], ["docs", "Urgent"]);
    await labels(["docs", "Urgent"], ["docs", "Urgent"]);
    const pipeline = (status: string, sha: string) =>
      hook("Pipeline Hook", {
        object_attributes: { sha, status },
        merge_request: { iid: 3, state: "opened" },
      });
    await pipeline("success", C1);
    await pipeline("failed", C1);
    await pipeline("failed", C1);
    await pipeline("failed", C2);
    await mr({ action: "merge", state: "merged" });
    await mr({ action: "merge", state: "merged" });
    await s.host.idle();
    await vi.waitFor(async () => expect(await runs()).toHaveLength(6));
    expect((await runs()).map((r) => [r.trigger, r.outcome]).sort()).toEqual([
      ["approved", "done"],
      ["checks_failed", "done"],
      ["checks_failed", "done"],
      ["labeled", "done"],
      ["merged", "done"],
      ["ready_for_review", "done"],
    ]);
    expect(notes.sort()).toEqual(
      ["approved", "checks_failed", "checks_failed", "labeled", "merged", "ready_for_review"].map(
        (body) => `${GITLAB}/api/v4/projects/group%2Fapi/merge_requests/3 ${body}`,
      ),
    );
  });
});

describe("a stale rule on the hourly run", () => {
  it("comments once on a merge request quiet for its hours", async () => {
    const { addRule, mr, runs } = await enrolled();
    await addRule("stale", { staleHours: 48, authors: ["mona"] });
    await mr({ action: "open" });
    await s.host.digests();
    expect(await runs()).toEqual([]);
    await s.host.db.update(schema.pullFlows).set({ seenAt: new Date(Date.now() - 49 * HOUR) });
    await s.host.digests();
    await s.host.digests();
    await s.host.idle();
    expect((await runs()).map((r) => [r.trigger, r.outcome])).toEqual([["stale", "done"]]);
    expect(notes).toEqual([`${NOTES.replace(/\/notes$/, "")} stale`]);
  });
});

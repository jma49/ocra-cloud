import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { C1, C2, GITLAB, repoFake } from "./graph-fakes.js";
import { graphServer, type Server } from "./graph-server.js";

// Automation rules on a self-hosted server with the ocra bot: a merge
// request queued for review runs the rules that match, writing on it as
// the bot, once per event; a skip keeps it from being reviewed.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-automations-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

type Sent = { method: string; url: string; auth: string | null; body: unknown };
const MR = `${GITLAB}/api/v4/projects/group%2Fapi/merge_requests/3`;

let s: Server;
let sent: Sent[];
/** The merge request's changed files, as GitLab lists its diffs. */
let changed: string[];
/** How many notes GitLab answers with a 502 before it takes one. */
let failNotes: number;
beforeEach(async () => {
  changed = [];
  failNotes = 0;
  s = await graphServer(dir, `automations-${n++}.db`, "off", undefined, {
    bots: { gitlabBotToken: "glbot" },
    workers: 0,
  });
  sent = [];
  const fake = repoFake({ [C1]: {} });
  const inner = fake.fetch.getMockImplementation();
  fake.fetch.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const record = async () =>
      sent.push({
        method: req.method,
        url: req.url,
        auth: req.headers.get("authorization"),
        body: req.method === "GET" ? null : await req.clone().json(),
      });
    if (req.url.startsWith(`${MR}/diffs?`)) {
      return Response.json(
        changed.map((path) => ({
          old_path: path,
          new_path: path,
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        })),
      );
    }
    if (req.url === MR || req.url === `${MR}/notes`) {
      await record();
      if (req.method === "POST" && failNotes-- > 0) return new Response("busy", { status: 502 });
      return Response.json(
        req.method === "GET"
          ? { reviewers: [{ id: 5 }], diff_refs: { base_sha: C2, head_sha: C1, start_sha: C2 } }
          : {},
      );
    }
    if (req.url === `${GITLAB}/api/v4/users?username=alice`) return Response.json([{ id: 9 }]);
    if (req.url === `${GITLAB}/api/v4/users?username=nobody`) return Response.json([]);
    if (!inner) throw new Error("no fake");
    return inner(input, init);
  });
});
afterEach(() => s.host.close());

async function enrolled() {
  const { auth } = await s.signIn(1);
  const res = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: auth,
    json: { platform: "gitlab", fullName: "group/api" },
  });
  const { repo, webhook } = (await res.json()) as {
    repo: { id: string };
    webhook: { secret: string };
  };
  const addRule = async (json: Record<string, unknown>) => {
    const added = await s.call("/api/automations/rules", { method: "POST", headers: auth, json });
    expect(added.status).toBe(200);
    return ((await added.json()) as { rule: Record<string, unknown> }).rule;
  };
  const hook = async (attributes: Record<string, unknown>, labels: string[] = []) => {
    const res = await s.call("/api/auto-review/webhooks/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhook.secret },
      json: {
        object_attributes: {
          iid: 3,
          last_commit: { id: C1 },
          title: "feat: parser",
          target_branch: "main",
          ...attributes,
        },
        project: { id: 21, path_with_namespace: "group/api" },
        user: { username: "octo" },
        labels: labels.map((title) => ({ title })),
      },
    });
    return ((await res.json()) as { queued: number }).queued;
  };
  const runs = async () =>
    (
      (await (await s.call("/api/automations/runs", { headers: auth })).json()) as {
        runs: { outcome: string; actions: unknown[]; attempts: number; retryAt: string | null }[];
      }
    ).runs;
  return { repo, addRule, hook, runs };
}

const jobs = () => s.host.db.select().from(schema.reviewJobs);

describe("a merge request queued for review", () => {
  it("is written on as the bot by the rules that match, once per event", async () => {
    const { repo, addRule, hook, runs } = await enrolled();
    const added = await addRule({
      name: "triage",
      trigger: "queued",
      conditions: { repoIds: [repo.id], title: "feat*", baseBranches: ["main"], authors: ["OCTO"] },
      actions: [
        { kind: "add_labels", labels: ["ocra"] },
        { kind: "request_reviewers", reviewers: ["alice", "nobody"] },
        { kind: "comment", body: "Thanks\r\nfor this" },
      ],
    });
    expect(added.runsHere).toBe(true);
    await addRule({
      name: "other branch",
      trigger: "queued",
      conditions: { baseBranches: ["release"] },
      actions: [{ kind: "comment", body: "never" }],
    });
    expect(await hook({ action: "open" })).toBe(1);
    await vi.waitFor(async () => expect((await runs())[0]?.outcome).toBe("done"));
    expect(sent.filter((x) => x.method !== "GET")).toEqual([
      { method: "PUT", url: MR, auth: "Bearer glbot", body: { add_labels: "ocra" } },
      { method: "PUT", url: MR, auth: "Bearer glbot", body: { reviewer_ids: [5, 9] } },
      {
        method: "POST",
        url: `${MR}/notes`,
        auth: "Bearer glbot",
        body: { body: "Thanks\nfor this" },
      },
    ]);
    // Delivered again: the event is taken. Given commits: only a skip would apply.
    expect(await hook({ action: "open" })).toBe(0);
    expect(await hook({ action: "update", oldrev: C1, last_commit: { id: C2 } })).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runs()).toHaveLength(1);
    expect(sent.filter((x) => x.method !== "GET")).toHaveLength(3);
  });

  it("is not reviewed when a rule skips it, on every head", async () => {
    const { addRule, hook, runs } = await enrolled();
    await addRule({
      name: "docs",
      trigger: "queued",
      conditions: { labels: ["Docs"] },
      actions: [{ kind: "skip_review" }],
    });
    expect(await hook({ action: "open" }, ["docs"])).toBe(0);
    expect(await hook({ action: "update", oldrev: C1, last_commit: { id: C2 } }, ["docs"])).toBe(0);
    expect(await jobs()).toEqual([]);
    await vi.waitFor(async () => expect(await runs()).toHaveLength(2));
    expect(await hook({ action: "open", last_commit: { id: "c".repeat(40) } })).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });
});

describe("a rule on paths", () => {
  it("skips the review of a merge request that changes only what it names", async () => {
    const { addRule, hook, runs } = await enrolled();
    await addRule({
      name: "docs only",
      trigger: "queued",
      conditions: { paths: { include: ["docs/", "*.md"], every: true } },
      actions: [{ kind: "skip_review" }],
    });
    changed = ["docs/intro.md", "README.md"];
    expect(await hook({ action: "open" })).toBe(0);
    changed = ["docs/intro.md", "src/a.ts"];
    expect(await hook({ action: "update", oldrev: C1, last_commit: { id: C2 } })).toBe(1);
    await vi.waitFor(async () => expect(await runs()).toHaveLength(1));
    expect(await jobs()).toHaveLength(1);
  });
});

describe("a write the platform did not answer", () => {
  it("is tried again, once per attempt, until it is taken", async () => {
    const { addRule, hook, runs } = await enrolled();
    await addRule({
      name: "thanks",
      trigger: "queued",
      conditions: {},
      actions: [{ kind: "comment", body: "Thanks" }],
    });
    failNotes = 1;
    expect(await hook({ action: "open" })).toBe(1);
    await vi.waitFor(async () => expect((await runs())[0]?.outcome).toBe("failed"));
    expect((await runs())[0]).toMatchObject({
      attempts: 1,
      actions: [{ kind: "comment", outcome: "unreached" }],
      retryAt: expect.any(String),
    });
    // Not due yet: nothing is sent.
    expect(await s.host.automationRetries()).toBe(0);
    await s.host.db.update(schema.automationRuns).set({ retryAt: new Date(0) });
    expect(await s.host.automationRetries()).toBe(1);
    expect((await runs())[0]).toMatchObject({
      outcome: "done",
      attempts: 2,
      actions: [{ kind: "comment", outcome: "done" }],
      retryAt: null,
    });
    expect(await s.host.automationRetries()).toBe(0);
    const notes = sent.filter((x) => x.method === "POST" && x.url === `${MR}/notes`);
    expect(notes).toHaveLength(2);
  });
});

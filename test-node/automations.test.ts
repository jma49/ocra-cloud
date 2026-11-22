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
beforeEach(async () => {
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
    if (req.url === MR || req.url === `${MR}/notes`) {
      await record();
      return Response.json(req.method === "GET" ? { reviewers: [{ id: 5 }] } : {});
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
        runs: { outcome: string; actions: unknown[] }[];
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

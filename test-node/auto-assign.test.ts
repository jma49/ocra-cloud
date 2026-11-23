import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, C2, C3, GITLAB, repoFake } from "./graph-fakes.js";
import { graphServer, type Server } from "./graph-server.js";

// A rule that assigns reviewers, on a self-hosted server with the ocra bot:
// a merge request that opens is read and written as the bot, each rule
// assigns on it once whatever events follow, and a round robin goes on to
// the next login with the next merge request.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-auto-assign-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const PROJECT = `${GITLAB}/api/v4/projects/group%2Fapi`;
const USERS: Record<string, number> = { octo: 1, alice: 9, bob: 10, carol: 11 };

let s: Server;
/** The reviewer ids GitLab set, per merge request, as the bot. */
let put: { iid: number; ids: number[]; auth: string | null }[];
/** Who each merge request has asked already. */
let reviewers: Record<number, string[]>;
let codeowners: string | null;
/** How many reviewer writes GitLab answers with a 502 before it takes one. */
let failPuts: number;
beforeEach(async () => {
  put = [];
  failPuts = 0;
  reviewers = {};
  codeowners = null;
  s = await graphServer(dir, `auto-assign-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api, gitlabBotToken: "glbot" },
    workers: 0,
  });
  const fake = repoFake({ [C1]: {} });
  const inner = fake.fetch.getMockImplementation();
  fake.fetch.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const mr = new RegExp(`^${PROJECT}/merge_requests/(\\d+)(/diffs\\?.*)?$`).exec(req.url);
    if (mr) {
      const iid = Number(mr[1]);
      if (mr[2]) {
        return Response.json([
          {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            new_file: false,
            deleted_file: false,
            renamed_file: false,
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          },
        ]);
      }
      if (req.method === "PUT") {
        const body = (await req.json()) as { reviewer_ids: number[] };
        put.push({ iid, ids: body.reviewer_ids, auth: req.headers.get("authorization") });
        if (failPuts-- > 0) return new Response("busy", { status: 502 });
        return Response.json({});
      }
      return Response.json({
        project_id: 21,
        author: { username: "octo" },
        diff_refs: { base_sha: C2, head_sha: C1, start_sha: C2 },
        reviewers: (reviewers[iid] ?? []).map((u) => ({ id: USERS[u], username: u })),
      });
    }
    if (req.url.startsWith(`${GITLAB}/api/v4/projects/21/repository/files/`)) {
      const path = decodeURIComponent(req.url.split("/files/")[1]?.split("?")[0] ?? "");
      if (path !== "CODEOWNERS" || codeowners === null) return new Response(null, { status: 404 });
      return Response.json({
        blob_id: "b".repeat(40),
        encoding: "base64",
        content: Buffer.from(codeowners).toString("base64"),
        size: codeowners.length,
      });
    }
    if (req.url.startsWith(`${GITLAB}/api/v4/merge_requests?`)) {
      return new Response("[]", { headers: { "x-total": "0" } });
    }
    const user = new RegExp(`^${GITLAB}/api/v4/users\\?username=(\\w+)$`).exec(req.url)?.[1];
    if (user) return Response.json(USERS[user] ? [{ id: USERS[user] }] : []);
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
  const { webhook } = (await res.json()) as { webhook: { secret: string } };
  const addRule = async (action: Record<string, unknown>) => {
    const added = await s.call("/api/automations/rules", {
      method: "POST",
      headers: auth,
      json: { name: "assign", trigger: "queued", conditions: {}, actions: [action] },
    });
    expect(added.status).toBe(200);
  };
  const hook = (iid: number, action: string, head = C1) =>
    s.call("/api/auto-review/webhooks/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhook.secret },
      json: {
        object_attributes: { iid, action, last_commit: { id: head }, title: "feat: x" },
        project: { id: 21, path_with_namespace: "group/api" },
        user: { username: "octo" },
      },
    });
  const runs = async () =>
    (
      (await (await s.call("/api/automations/runs", { headers: auth })).json()) as {
        runs: { pull: string; outcome: string; actions: { outcome: string }[] }[];
      }
    ).runs;
  const settled = async (count: number) => {
    await vi.waitFor(async () => {
      const all = await runs();
      expect(all).toHaveLength(count);
      expect(all.every((r) => r.outcome !== "running")).toBe(true);
    });
    return (await runs()).map((r) => `${r.pull} ${r.actions[0]?.outcome}`);
  };
  return { addRule, hook, settled };
}

describe("a round robin", () => {
  it("asks the next login of each merge request that opens, once per merge request", async () => {
    const { addRule, hook, settled } = await enrolled();
    await addRule({
      kind: "assign_reviewers",
      strategy: "round_robin",
      count: 1,
      logins: ["octo", "alice", "bob"],
    });
    await hook(3, "open");
    await settled(1);
    // Reopened at another head, and delivered again: no one more is asked.
    await hook(3, "reopen", C2);
    await hook(3, "reopen", C2);
    await settled(2);
    await hook(4, "open");
    await settled(3);
    await hook(5, "open", C3);
    expect(await settled(4)).toEqual([
      "group/api#5 done",
      "group/api#4 done",
      "group/api#3 already_assigned",
      "group/api#3 done",
    ]);
    // The author is passed over, and the list goes round.
    expect(put).toEqual([
      { iid: 3, ids: [9], auth: "Bearer glbot" },
      { iid: 4, ids: [10], auth: "Bearer glbot" },
      { iid: 5, ids: [9], auth: "Bearer glbot" },
    ]);
  });

  it("asks no one on a merge request that has its count already", async () => {
    const { addRule, hook, settled } = await enrolled();
    await addRule({ kind: "assign_reviewers", strategy: "round_robin", count: 1, logins: ["bob"] });
    reviewers[3] = ["alice"];
    await hook(3, "open");
    expect(await settled(1)).toEqual(["group/api#3 enough_reviewers"]);
    expect(put).toEqual([]);
  });
});

describe("suggested reviewers", () => {
  it("are the changed files' code owners, keeping those already asked", async () => {
    const { addRule, hook, settled } = await enrolled();
    await addRule({ kind: "assign_reviewers", strategy: "suggested", count: 2 });
    codeowners = "* @carol @octo\n";
    reviewers[3] = ["alice"];
    await hook(3, "open");
    expect(await settled(1)).toEqual(["group/api#3 done"]);
    expect(put).toEqual([{ iid: 3, ids: [9, 11], auth: "Bearer glbot" }]);
  });

  it("asks no one, and says so, when there is no one to suggest", async () => {
    const { addRule, hook, settled } = await enrolled();
    await addRule({ kind: "assign_reviewers", strategy: "suggested", count: 1 });
    await hook(3, "open");
    expect(await settled(1)).toEqual(["group/api#3 no_candidates"]);
    expect(put).toEqual([]);
  });
});

describe("an assignment the platform did not answer", () => {
  it("asks the same logins again, without moving the round robin", async () => {
    const { addRule, hook, settled } = await enrolled();
    await addRule({
      kind: "assign_reviewers",
      strategy: "round_robin",
      count: 1,
      logins: ["alice", "bob"],
    });
    failPuts = 1;
    await hook(3, "open");
    expect(await settled(1)).toEqual(["group/api#3 unreached"]);
    await s.host.db.update(schema.automationRuns).set({ retryAt: new Date(0) });
    expect(await s.host.automationRetries()).toBe(1);
    expect(await settled(1)).toEqual(["group/api#3 done"]);
    await hook(4, "open");
    await settled(2);
    expect(put.map((p) => [p.iid, p.ids])).toEqual([
      [3, [9]],
      [3, [9]],
      [4, [10]],
    ]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CallBudget } from "../src/calls.js";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import type { AutoEnrollGroupsView, BulkEnrollView } from "../src/shared/index.js";
import { C1 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// Enrolling GitLab projects in bulk, each with its hook as one enrollment
// adds it, and a GitLab group's new projects for the one account that
// turned the group's switch on, found by the daily sweep of its projects.

const BOT_TOKEN = "glpat-bot-token-for-hooks";
const HOOK_URL = `${ORIGIN}/api/auto-review/webhooks/gitlab`;
const DAY = 24 * 60 * 60_000;

type Project = { id: number; path: string; branch: string | null; createdAt: string };

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-gitlab-groups-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

let s: Server;
/** The group's projects, by id. */
let projects: Map<number, Project>;
/** Each project's hooks, by project id. */
let hooks: Map<number, { id: number; url: string }[]>;
/** Projects whose hooks GitLab refuses: the bot is below Maintainer there. */
let refusedHooks: Set<number>;
/** The users' tokens that maintain group 5. */
let maintainers: Set<string>;
let calls: string[];

const project = (id: number, path: string, branch: string | null = "main", ago = 0) =>
  projects.set(id, {
    id,
    path,
    branch,
    createdAt: new Date(Date.now() - ago).toISOString(),
  });

beforeEach(async () => {
  s = await graphServer(dir, `gitlab-groups-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api, gitlabBotToken: BOT_TOKEN },
    workers: 0,
  });
  projects = new Map();
  hooks = new Map();
  refusedHooks = new Set();
  maintainers = new Set(["glpat_1", "glpat_2"]);
  calls = [];
  project(10, "acme/api");
  project(20, "acme/web");
  project(30, "acme/tools/cli");
  let nextHook = 100;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}`);
    const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    const path = url.pathname.replace("/api/v4", "");
    if (path === "/groups") {
      const listed = maintainers.has(token) ? [{ id: 5, full_path: "acme" }] : [];
      return Response.json(url.searchParams.get("page") === "1" ? listed : []);
    }
    if (path === "/groups/5/projects") {
      if (!maintainers.has(token)) return Response.json({ message: "404" }, { status: 404 });
      const listed = [...projects.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, Number(url.searchParams.get("per_page")))
        .map((p) => ({
          id: p.id,
          path_with_namespace: p.path,
          default_branch: p.branch,
          created_at: p.createdAt,
        }));
      return Response.json(listed);
    }
    const byPath = /^\/projects\/([^/]+)$/.exec(path)?.[1];
    if (byPath) {
      const p = [...projects.values()].find((x) => x.path === decodeURIComponent(byPath));
      return p
        ? Response.json({ id: p.id, path_with_namespace: p.path, default_branch: p.branch })
        : Response.json({ message: "404" }, { status: 404 });
    }
    if (/^\/projects\/\d+\/repository\/branches\/main$/.test(path)) {
      return Response.json({ commit: { id: C1 } });
    }
    const hooked = /^\/projects\/(\d+)\/hooks$/.exec(path)?.[1];
    if (hooked) {
      const id = Number(hooked);
      if (refusedHooks.has(id)) return Response.json({ message: "403" }, { status: 403 });
      const list = hooks.get(id) ?? [];
      if (req.method === "GET") return Response.json(list);
      const hook = { id: nextHook++, url: ((await req.json()) as { url: string }).url };
      hooks.set(id, [...list, hook]);
      return Response.json(hook, { status: 201 });
    }
    return new Response(null, { status: 404 });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await s.host.close();
});

const bulk = (auth: Record<string, string>, json: unknown) =>
  s.call("/api/auto-review/repos/bulk", { method: "POST", headers: auth, json });

const toggle = (auth: Record<string, string>, id: string, json: unknown) =>
  s.call(`/api/auto-review/gitlab/groups/${id}/auto-enroll`, {
    method: "PUT",
    headers: auth,
    json,
  });

const repos = () => s.host.db.select().from(schema.reviewRepos);

/** The groups' switches as stored. */
async function groupRows() {
  expect(schema).toHaveProperty("autoEnrollGroups");
  return s.host.db.select().from(schema.autoEnrollGroups);
}

/** Every group due its sweep again, as a day later. */
async function aDayLater() {
  expect(schema).toHaveProperty("autoEnrollGroups");
  await s.host.db.update(schema.autoEnrollGroups).set({ sweptAt: new Date(Date.now() - 2 * DAY) });
}

/** The hourly sweep of the groups due, within `calls` where given; how many groups it claimed. */
function sweep(calls?: CallBudget): Promise<number> {
  const host = s.host as { groupSweep?: (calls?: CallBudget) => Promise<number> };
  expect(host.groupSweep).toBeTypeOf("function");
  return host.groupSweep?.(calls) ?? Promise.resolve(0);
}

describe("bulk enrollment of GitLab projects", () => {
  it("enrolls each with its hook, says when the hook is added by hand, and keeps a project's secret when enrolled again", async () => {
    refusedHooks.add(20);
    const { auth, account } = await s.signIn(1);
    const res = await bulk(auth, {
      platform: "gitlab",
      fullNames: ["acme/api", "acme/web", "acme/missing", "ACME/api"],
      automatic: true,
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as BulkEnrollView;
    expect(results).toEqual([
      expect.objectContaining({
        fullName: "acme/api",
        outcome: "enrolled",
        repo: expect.objectContaining({ platform: "gitlab", webhookManaged: true }),
        webhook: expect.objectContaining({ url: HOOK_URL, managed: true }),
      }),
      expect.objectContaining({
        fullName: "acme/web",
        outcome: "enrolled",
        webhook: expect.objectContaining({ managed: false, problem: expect.any(String) }),
      }),
      { fullName: "acme/missing", outcome: "refused", reason: "not_found" },
    ]);
    expect(hooks.get(10)).toEqual([expect.objectContaining({ url: HOOK_URL })]);
    const stored = await repos();
    expect(stored.map((r) => [r.fullName, r.accountId, r.automatic]).sort()).toEqual([
      ["acme/api", account.id, true],
      ["acme/web", account.id, true],
    ]);
    // The project whose hook is added by hand proves itself with the secret answered.
    expect(stored.every((r) => r.webhookSecretHash !== null)).toBe(true);

    const again = (await (
      await bulk(auth, { platform: "gitlab", fullNames: ["acme/api"] })
    ).json()) as BulkEnrollView;
    expect(again.results).toEqual([
      expect.objectContaining({ fullName: "acme/api", outcome: "already" }),
    ]);
    expect(again.results[0]).not.toHaveProperty("webhook");
    expect((await repos()).map((r) => r.webhookSecretHash).sort()).toEqual(
      stored.map((r) => r.webhookSecretHash).sort(),
    );
    expect(hooks.get(10)).toHaveLength(1);
  });

  it("refuses more GitLab projects than one request's calls allow, and another account's project", async () => {
    const one = await s.signIn(1);
    const names = Array.from({ length: 11 }, (_, i) => `acme/p${i}`);
    expect((await bulk(one.auth, { platform: "gitlab", fullNames: names })).status).toBe(400);
    await bulk(one.auth, { platform: "gitlab", fullNames: ["acme/api"] });
    const two = await s.signIn(2);
    const { results } = (await (
      await bulk(two.auth, { platform: "gitlab", fullNames: ["acme/api"] })
    ).json()) as BulkEnrollView;
    expect(results).toEqual([{ fullName: "acme/api", outcome: "refused", reason: "taken" }]);
  });
});

describe("a GitLab group's new projects", () => {
  it("are switched on for a group the user maintains, by one account only", async () => {
    const one = await s.signIn(1);
    const listed = (await (
      await s.call("/api/auto-review/gitlab/groups", { headers: one.auth })
    ).json()) as AutoEnrollGroupsView;
    expect(listed).toEqual({
      groups: [{ id: "5", fullPath: "acme", enabled: false, automatic: false }],
      more: false,
    });
    const on = await toggle(one.auth, "5", { enabled: true, automatic: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ id: "5", fullPath: "acme", enabled: true, automatic: true });
    const [row] = await groupRows();
    // The projects until now are left to bulk enrollment.
    expect(row).toMatchObject({ accountId: one.account.id, groupId: "5", lastProjectId: 30 });

    const two = await s.signIn(2);
    expect((await toggle(two.auth, "5", { enabled: true })).status).toBe(400);
    const listedToTwo = (await (
      await s.call("/api/auto-review/gitlab/groups", { headers: two.auth })
    ).json()) as AutoEnrollGroupsView;
    expect(listedToTwo.groups).toEqual([
      { id: "5", fullPath: "acme", enabled: false, automatic: false },
    ]);
    // Off from another account changes nothing of this one's.
    await toggle(two.auth, "5", { enabled: false });
    expect(await groupRows()).toHaveLength(1);

    const three = await s.signIn(3);
    expect((await toggle(three.auth, "5", { enabled: true })).status).toBe(404);
    const audit = await (await s.call("/api/audit", { headers: one.auth })).text();
    expect(audit).toContain("auto_review.auto_enroll_changed");
    expect(audit).toContain("acme");

    expect((await toggle(one.auth, "5", { enabled: false })).status).toBe(200);
    expect(await groupRows()).toHaveLength(0);
  });

  it("are enrolled once by the sweep, with their hook, and not again once unenrolled", async () => {
    const one = await s.signIn(1);
    await s.signIn(2);
    await toggle(one.auth, "5", { enabled: true, automatic: true });
    project(31, "acme/tools/new");
    // Made empty just now: waited for, as are the ones after it.
    project(32, "acme/empty", null);
    expect(await sweep()).toBe(1);
    let stored = await repos();
    expect(stored.map((r) => [r.fullName, r.accountId, r.automatic])).toEqual([
      ["acme/tools/new", one.account.id, true],
    ]);
    expect(stored[0]?.webhookId).not.toBeNull();
    expect(hooks.get(31)).toEqual([expect.objectContaining({ url: HOOK_URL })]);
    const [group] = await groupRows();
    expect(group?.lastProjectId).toBe(31);

    // Not due again the same day.
    expect(await sweep()).toBe(0);

    await s.call(`/api/auto-review/repos/${stored[0]?.id}`, {
      method: "DELETE",
      headers: one.auth,
    });
    const pushed = projects.get(32);
    if (pushed) pushed.branch = "main";
    await aDayLater();
    expect(await sweep()).toBe(1);
    stored = await repos();
    expect(stored.map((r) => r.fullName)).toEqual(["acme/empty"]);
  });

  it("go on from where a run's calls ran out", async () => {
    const one = await s.signIn(1);
    await toggle(one.auth, "5", { enabled: true });
    project(41, "acme/a");
    project(42, "acme/b");
    project(43, "acme/c");
    // The listing, then one project's two reads and its hook; the next needs more than is left.
    const budget = new CallBudget(6);
    await sweep(budget);
    expect(budget.spent).toBeLessThanOrEqual(6);
    expect((await repos()).map((r) => r.fullName)).toEqual(["acme/a"]);
    const [cut] = await groupRows();
    expect(cut?.lastProjectId).toBe(41);
    // Given back: the next run sweeps it again, from the mark.
    expect(cut?.sweptAt).toBeNull();

    await sweep(new CallBudget(45));
    expect((await repos()).map((r) => r.fullName).sort()).toEqual(["acme/a", "acme/b", "acme/c"]);
    const reads = calls.filter((c) => c === "GET /api/v4/projects/acme%2Fa");
    expect(reads).toHaveLength(1);
    expect((await repos()).every((r) => r.accountId === one.account.id)).toBe(true);
  });
});

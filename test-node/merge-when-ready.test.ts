import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { MERGE_LEASE_MS } from "../src/db/merge-intents.js";
import { scoped } from "../src/db/scoped.js";
import { repoIdentity } from "../src/platforms/platform.js";
import type { MergeWhenReadyAnswer, MergeWhenReadyView } from "../src/shared/index.js";
import { C1, C2, GITLAB } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// Merge when ready: GitHub's own auto-merge where the repository allows it;
// elsewhere an intent the server keeps, moved by the enrolled repository's
// webhooks and merged once, as the user, at the head it was armed at.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-merge-when-ready-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const GRAPHQL = "https://api.github.com/graphql";
const MERGE = "https://api.github.com/repos/octo/api/pulls/7/merge";
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

type Pull = { allowed: boolean; state: string; head: string; open: string };
type Mutation = { query: string; variables: Record<string, unknown> };

let s: Server;
let pull: Pull;
let mutations: Mutation[];
let merges: Record<string, unknown>[];
let chats: string[];

beforeEach(async () => {
  s = await graphServer(dir, `merge-when-ready-${n++}.db`, "off", undefined, {
    bots: {},
    workers: 0,
  });
  pull = { allowed: true, state: "BLOCKED", head: C1, open: "OPEN" };
  mutations = [];
  merges = [];
  chats = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    if (url.toLowerCase() === "https://api.github.com/repos/octo/api") {
      return Response.json({ id: 11, full_name: "Octo/API", default_branch: "main" });
    }
    if (url.toLowerCase() === "https://api.github.com/repos/octo/api/branches/main") {
      return Response.json({ commit: { sha: C1 } });
    }
    if (url === GRAPHQL) {
      const body = (await req.json()) as Mutation;
      if (body.query.startsWith("mutation")) {
        mutations.push(body);
        return Response.json({ data: { done: { clientMutationId: null } } });
      }
      return Response.json({
        data: {
          repository: {
            autoMergeAllowed: pull.allowed,
            pullRequest: {
              id: "PR_7",
              headRefOid: pull.head,
              state: pull.open,
              mergeStateStatus: pull.state,
              autoMergeRequest: mutations.length > 0 ? { mergeMethod: "SQUASH" } : null,
            },
          },
        },
      });
    }
    if (req.method === "PUT" && url.toLowerCase() === MERGE) {
      const body = (await req.json()) as Record<string, unknown>;
      merges.push(body);
      return body.sha === pull.head
        ? Response.json({ merged: true })
        : new Response(null, { status: 409 });
    }
    if (url.startsWith("https://hooks.slack.com/")) {
      chats.push(((await req.json()) as { text: string }).text);
      return new Response("ok");
    }
    return new Response(null, { status: 404 });
  });
});
afterEach(() => s.host.close());

const ref = { platform: "github", repo: "octo/api", number: 7 };

async function me(enroll: boolean, id = 1) {
  const user = await s.signIn(id);
  if (enroll) {
    const res = await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: user.auth,
      json: { platform: "github", fullName: "octo/api" },
    });
    expect(res.status).toBe(200);
  }
  return user;
}

async function arm(auth: Record<string, string>, json: Record<string, unknown> = {}) {
  const res = await s.call("/api/pulls/merge-when-ready", {
    method: "POST",
    headers: auth,
    json: { ...ref, method: "squash", head: C1, ...json },
  });
  return (await res.json()) as MergeWhenReadyAnswer;
}

async function view(auth: Record<string, string>) {
  const query = "platform=github&repo=octo/api&number=7";
  const res = await s.call(`/api/pulls/merge-when-ready?${query}`, { headers: auth });
  return (await res.json()) as MergeWhenReadyView;
}

async function deliver(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ ...payload, repository: { id: 11, full_name: "Octo/API" } });
  const res = await s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

const checkDone = (head: string) =>
  deliver("check_suite", { action: "completed", check_suite: { head_sha: head } });

const pushed = (head: string) =>
  deliver("pull_request", {
    action: "synchronize",
    number: 7,
    pull_request: { head: { sha: head } },
  });

/** Lets the webhooks' work after the answer finish. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("merge when ready", () => {
  it("arms GitHub's own auto-merge where the repository allows it, and turns it off", async () => {
    const { auth } = await me(false);
    const armed = await arm(auth);
    expect(armed).toMatchObject({
      outcome: "done",
      intent: { mode: "native", method: "squash", head: C1, state: "armed", armedBy: "user-1" },
    });
    expect(mutations.map((m) => m.variables)).toEqual([{ id: "PR_7", method: "SQUASH", head: C1 }]);
    const cancelled = await s.call("/api/pulls/merge-when-ready", {
      method: "DELETE",
      headers: auth,
      json: ref,
    });
    expect(await cancelled.json()).toMatchObject({
      outcome: "done",
      intent: { state: "cancelled" },
    });
    expect(mutations.at(-1)?.query).toContain("disablePullRequestAutoMerge");
    expect(merges).toEqual([]);
  });

  it("is unavailable where auto-merge is off and the repository is not enrolled", async () => {
    pull.allowed = false;
    const { auth } = await me(false);
    expect(await arm(auth)).toEqual({ outcome: "unavailable", intent: null });
    expect(await view(auth)).toEqual({ intent: null, server: false });
  });

  it("keeps the intent on the server and merges once, as the user, when it is ready", async () => {
    pull.allowed = false;
    const { auth, data } = await me(true);
    const added = await s.call("/api/notifications/channels", {
      method: "POST",
      headers: auth,
      json: {
        kind: "slack",
        url: SLACK,
        name: "team",
        when: "blocking",
        events: ["merge_when_ready"],
      },
    });
    expect(added.status, await added.clone().text()).toBe(200);
    const armed = await arm(auth);
    expect(armed).toMatchObject({
      outcome: "done",
      intent: { mode: "server", state: "armed", reason: "waiting_platform" },
    });
    expect(merges).toEqual([]);
    pull.state = "CLEAN";
    await Promise.all([checkDone(C1), checkDone(C1), checkDone(C1)]);
    await vi.waitFor(async () => expect((await view(auth)).intent?.state).toBe("merged"));
    await settle();
    expect(merges).toEqual([{ merge_method: "squash", sha: C1 }]);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain("was merged");
    const kinds = (await data.find("auditEvents", {})).map((e) => e.kind).sort();
    expect(kinds).toEqual(["merge_when_ready.armed", "merge_when_ready.merged"]);
  });

  it("merges at once a pull request that is ready when it is armed", async () => {
    pull.allowed = true;
    pull.state = "CLEAN";
    const { auth } = await me(true);
    expect((await arm(auth)).intent).toMatchObject({ mode: "server", state: "merged" });
    expect(merges).toEqual([{ merge_method: "squash", sha: C1 }]);
  });

  it("is disarmed by a push, unless it was kept armed on new commits", async () => {
    pull.allowed = false;
    const { auth } = await me(true);
    await arm(auth);
    pull.head = C2;
    pull.state = "CLEAN";
    await pushed(C2);
    await vi.waitFor(async () =>
      expect((await view(auth)).intent).toMatchObject({ state: "disarmed", reason: "head_moved" }),
    );
    expect(merges).toEqual([]);

    pull.head = C1;
    pull.state = "BLOCKED";
    expect((await arm(auth, { keepOnPush: true })).intent).toMatchObject({ state: "armed" });
    pull.head = C2;
    pull.state = "CLEAN";
    await pushed(C2);
    await vi.waitFor(async () => expect((await view(auth)).intent?.state).toBe("merged"));
    expect(merges).toEqual([{ merge_method: "squash", sha: C2 }]);
  });

  it("waits while ocra's review of the head has a critical finding", async () => {
    pull.allowed = false;
    const { auth, data } = await me(true);
    await data.insert("reviews", {
      runId: "run-1",
      repoHash: "h",
      source: "github",
      critical: 1,
      prRepository: repoIdentity({ url: "https://github.com" }, "Octo/API"),
      prNumber: 7,
      prHeadSha: C1,
    });
    await arm(auth);
    pull.state = "CLEAN";
    await checkDone(C1);
    await vi.waitFor(async () => expect((await view(auth)).intent?.reason).toBe("blocking_review"));
    expect((await view(auth)).intent?.state).toBe("armed");
    expect(merges).toEqual([]);
  });

  it("is the account's own: another account neither sees nor cancels it", async () => {
    pull.allowed = false;
    const mine = await me(true);
    await arm(mine.auth);
    const theirs = await me(false, 2);
    expect((await view(theirs.auth)).intent).toBeNull();
    await s.call("/api/pulls/merge-when-ready", {
      method: "DELETE",
      headers: theirs.auth,
      json: ref,
    });
    expect((await view(mine.auth)).intent?.state).toBe("armed");
  });

  it("moves on a GitLab hook only the intents of the project whose secret proved it", async () => {
    const { auth, account } = await me(false);
    const route = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      const lab = `${GITLAB}/api/v4/projects/`;
      if (url === `${lab}group%2Fapi`) {
        return Response.json({ id: 21, path_with_namespace: "group/api", default_branch: "main" });
      }
      if (url === `${lab}21/repository/branches/main`) return Response.json({ commit: { id: C1 } });
      return route ? route(input, init) : new Response(null, { status: 404 });
    });
    const res = await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: auth,
      json: { platform: "gitlab", fullName: "group/api" },
    });
    expect(res.status).toBe(200);
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const intents = scoped(s.host.db, account.id).mergeIntents;
    const armed = { platform: "gitlab" as const, host: new URL(GITLAB).host, number: 5 };
    const intent = { method: "merge", mode: "server", head: C1, keepOnPush: false } as const;
    for (const fullName of ["group/api", "group/web"]) {
      await intents.arm({ ...armed, ...intent, fullName, armedBy: "user-1" }, new Date());
    }
    // group/api's secret, with a body that names another project of the account.
    const hook = await s.call("/api/auto-review/webhooks/gitlab", {
      method: "POST",
      headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhook.secret },
      json: {
        object_attributes: { iid: 5, action: "close", state: "closed", last_commit: { id: C1 } },
        project: { id: 21, path_with_namespace: "group/web" },
      },
    });
    expect(hook.status).toBe(202);
    const of = (fullName: string) => intents.of({ ...armed, fullName }, 5);
    await vi.waitFor(async () => expect((await of("group/api"))?.state).toBe("closed"));
    expect((await of("group/web"))?.state).toBe("armed");
  });

  it("lets one runner claim a merge, keeps it from a new arming, and takes over a lapsed claim", async () => {
    pull.allowed = false;
    const { auth, account } = await me(true);
    await arm(auth);
    const intents = scoped(s.host.db, account.id).mergeIntents;
    const key = { platform: "github" as const, host: "github.com", fullName: "Octo/API" };
    const intent = await intents.of(key, 7);
    if (!intent) throw new Error("not armed");
    const now = new Date();
    const claims = await Promise.all([1, 2, 3].map(() => intents.claim(intent.id, C1, now)));
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    expect(await intents.claim(intent.id, C2, now)).toBeNull();
    const again = await intents.arm({ ...key, ...intent, head: C2 }, now);
    expect(again).toMatchObject({ state: "merging", head: C1 });
    const later = new Date(now.getTime() + MERGE_LEASE_MS + 1);
    const taken = await intents.claim(intent.id, C1, later);
    expect(taken).toEqual(later);
    expect(await intents.release(intent.id, now, "waiting_platform", later)).toBe(false);
    expect(await intents.release(intent.id, later, "waiting_platform", later)).toBe(true);
    expect(await intents.claim(intent.id, C1, later)).toEqual(later);
    const lapsed = new Date(later.getTime() + MERGE_LEASE_MS + 1);
    expect(await intents.arm({ ...key, ...intent, head: C2 }, lapsed)).toMatchObject({
      state: "armed",
      head: C2,
    });
  });
});

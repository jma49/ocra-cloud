import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, GITLAB } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// Enrolling a GitLab project adds its webhook with the bot's token when
// GitLab lets it (Maintainer), or updates the one already there; below
// that role the address and secret are added by hand as before. The hook
// ocra added goes when the project is unenrolled.

const BOT_TOKEN = "glpat-bot-token-for-hooks";
const HOOK_URL = `${ORIGIN}/api/auto-review/webhooks/gitlab`;
const HOOKS = `${GITLAB}/api/v4/projects/21/hooks`;

type Hook = { id: number; url: string; token?: string; [event: string]: unknown };

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-gitlab-hook-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
/** The project's hooks as GitLab keeps them. */
let hooks: Hook[];
/** The status GitLab answers the hooks API with in place of doing it, when set. */
let refuse: number | undefined;
let calls: { method: string; url: string; auth: string | null }[];

beforeEach(async () => {
  s = await graphServer(dir, `gitlab-hook-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api, gitlabBotToken: BOT_TOKEN },
    workers: 0,
  });
  hooks = [];
  refuse = undefined;
  calls = [];
  let next = 100;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    const lab = `${GITLAB}/api/v4/projects/`;
    if (url === `${lab}group%2Fapi`) {
      return Response.json({ id: 21, path_with_namespace: "group/api", default_branch: "main" });
    }
    if (url === `${lab}21/repository/branches/main`) return Response.json({ commit: { id: C1 } });
    if (!url.startsWith(HOOKS)) return new Response(null, { status: 404 });
    calls.push({ method: req.method, url, auth: req.headers.get("authorization") });
    if (refuse) return Response.json({ message: "403 Forbidden" }, { status: refuse });
    const id = Number(/hooks\/(\d+)$/.exec(url)?.[1]);
    const at = hooks.findIndex((h) => h.id === id);
    if (req.method === "GET") return Response.json(hooks.map(({ token: _t, ...h }) => h));
    if (req.method === "POST") {
      const hook = { ...((await req.json()) as Hook), id: next++ };
      hooks.push(hook);
      return Response.json({ id: hook.id, url: hook.url }, { status: 201 });
    }
    if (at < 0) return Response.json({ message: "404 Not found" }, { status: 404 });
    if (req.method === "PUT") {
      hooks[at] = { ...hooks[at], ...((await req.json()) as Hook), id };
      return Response.json({ id, url: hooks[at]?.url });
    }
    hooks.splice(at, 1);
    return new Response(null, { status: 204 });
  });
});
afterEach(() => s.host.close());

async function enroll(auth: Record<string, string>) {
  const res = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: auth,
    json: { platform: "gitlab", fullName: "group/api" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    repo: { id: string; webhookManaged: boolean };
    webhook: { url: string; secret: string; managed?: boolean; problem?: string };
  };
}

const setUp = (auth: Record<string, string>, id: string) =>
  s.call(`/api/auto-review/repos/${id}/webhook`, { method: "POST", headers: auth });

const newSecret = (auth: Record<string, string>, id: string) =>
  s.call(`/api/auto-review/repos/${id}/webhook/secret`, { method: "POST", headers: auth });

/** Whether the GitLab webhook endpoint takes a delivery proven by `secret`. */
async function delivers(secret: string) {
  const res = await s.call("/api/auto-review/webhooks/gitlab", {
    method: "POST",
    headers: { "x-gitlab-event": "Pipeline Hook", "x-gitlab-token": secret },
    json: { object_kind: "pipeline", project: { id: 21 } },
  });
  return res.status !== 401;
}

const storedRepo = async () => (await s.host.db.select().from(schema.reviewRepos))[0];

describe("a GitLab project's webhook", () => {
  it("is added at enrolment with the bot's token, the events ocra reads and the secret", async () => {
    const { auth } = await s.signIn(1);
    const { repo, webhook } = await enroll(auth);
    expect(webhook).toMatchObject({ url: HOOK_URL, managed: true });
    expect(webhook.problem).toBeUndefined();
    expect(repo.webhookManaged).toBe(true);
    expect(hooks).toEqual([
      expect.objectContaining({
        url: HOOK_URL,
        token: webhook.secret,
        merge_requests_events: true,
        note_events: true,
        pipeline_events: true,
        enable_ssl_verification: true,
      }),
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${BOT_TOKEN}`)).toBe(true);
    const row = await storedRepo();
    expect(row?.webhookId).toBe(String(hooks[0]?.id));
    expect(row?.webhookSecretHash).toBe(await sha256Hex(webhook.secret));
    expect(await delivers(webhook.secret)).toBe(true);
    const listed = await (await s.call("/api/auto-review/repos", { headers: auth })).json();
    expect(listed).toMatchObject({ repos: [{ id: repo.id, webhookManaged: true }] });
    const audit = await (await s.call("/api/audit", { headers: auth })).text();
    expect(audit).toContain("auto_review.webhook_added");
    expect(audit).not.toContain(BOT_TOKEN);
    expect(audit).not.toContain(webhook.secret);
  });

  it("is updated in place, not added twice, and takes a new secret when set up again", async () => {
    // One added by hand before, under the same address written with a trailing slash.
    hooks.push({ id: 7, url: `${HOOK_URL}/`, token: "by-hand", push_events: true });
    const { auth } = await s.signIn(1);
    const { repo, webhook } = await enroll(auth);
    expect(webhook.managed).toBe(true);
    expect(hooks.map((h) => [h.id, h.token])).toEqual([[7, webhook.secret]]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);

    const again = await setUp(auth, repo.id);
    expect(again.status).toBe(200);
    const view = (await again.json()) as { url: string; secret: string; managed: boolean };
    expect(view).toMatchObject({ url: HOOK_URL, managed: true });
    expect(view.secret).not.toBe(webhook.secret);
    expect(hooks.map((h) => [h.id, h.token])).toEqual([[7, view.secret]]);
    expect(await delivers(view.secret)).toBe(true);
    expect(await delivers(webhook.secret)).toBe(false);
  });

  it("is left to be added by hand when the token is below Maintainer, and the secret still works", async () => {
    refuse = 403;
    const { auth } = await s.signIn(1);
    const { repo, webhook } = await enroll(auth);
    expect(webhook.managed).toBe(false);
    expect(webhook.problem).toContain("Maintainer");
    expect(webhook.problem).toContain(HOOK_URL);
    expect(repo.webhookManaged).toBe(false);
    expect(await delivers(webhook.secret)).toBe(true);

    const again = await setUp(auth, repo.id);
    expect(again.status).toBe(400);
    const body = (await again.json()) as { error: string; issues: { message: string }[] };
    expect(body.error).toBe("invalid_body");
    expect(body.issues[0]?.message).toContain("Maintainer");
    expect(body.issues[0]?.message).toContain(HOOK_URL);
    expect(body.issues[0]?.message).toContain(`/api/auto-review/repos/${repo.id}/webhook/secret`);
    // The secret the hook added by hand proves itself with is kept.
    expect(await delivers(webhook.secret)).toBe(true);
    expect((await storedRepo())?.webhookId).toBeNull();
  });

  it("is removed when the project is unenrolled", async () => {
    const { auth } = await s.signIn(1);
    const { repo } = await enroll(auth);
    expect(hooks).toHaveLength(1);
    const res = await s.call(`/api/auto-review/repos/${repo.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(await res.json()).toEqual({ removed: true });
    expect(hooks).toEqual([]);
    expect(calls.at(-1)?.method).toBe("DELETE");
    const audit = await (await s.call("/api/audit", { headers: auth })).text();
    expect(audit).toContain("auto_review.webhook_removed");
  });

  it("does not keep the project enrolled when GitLab refuses to remove its hook", async () => {
    const { auth } = await s.signIn(1);
    const { repo } = await enroll(auth);
    refuse = 403;
    const res = await s.call(`/api/auto-review/repos/${repo.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(await s.host.db.select().from(schema.reviewRepos)).toEqual([]);
    const audit = (await (await s.call("/api/audit", { headers: auth })).json()) as {
      events: { kind: string; detail: Record<string, unknown> }[];
    };
    expect(audit.events.find((e) => e.kind === "auto_review.webhook_removed")?.detail).toEqual({
      repo: "group/api",
      removed: false,
    });
  });

  it("gets a new secret to be added by hand with, and the old one is no longer accepted", async () => {
    refuse = 403;
    const { auth } = await s.signIn(1);
    const { repo, webhook } = await enroll(auth);
    const before = calls.length;
    const res = await newSecret(auth, repo.id);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { url: string; secret: string; events: string[] };
    expect(view).toEqual({
      url: HOOK_URL,
      secret: expect.stringMatching(/^ocra_hook_/),
      events: ["Merge request events", "Comments", "Pipeline events"],
    });
    expect(view.secret).not.toBe(webhook.secret);
    // Nothing is asked of GitLab: the hook is added by hand.
    expect(calls).toHaveLength(before);
    expect((await storedRepo())?.webhookSecretHash).toBe(await sha256Hex(view.secret));
    expect(await delivers(view.secret)).toBe(true);
    expect(await delivers(webhook.secret)).toBe(false);

    const audit = (await (await s.call("/api/audit", { headers: auth })).json()) as {
      events: { kind: string; detail: Record<string, unknown> }[];
    };
    expect(
      audit.events.find((e) => e.kind === "auto_review.webhook_secret_rotated")?.detail,
    ).toEqual({ repo: "group/api" });
    for (const path of ["/api/audit", "/api/auto-review/repos", "/api/export"]) {
      const text = await (await s.call(path, { headers: auth })).text();
      expect(text).not.toContain(view.secret);
      expect(text).not.toContain(await sha256Hex(view.secret));
    }
  });

  it("leaves the hook ocra added to the user once it gets a new secret by hand", async () => {
    const { auth } = await s.signIn(1);
    const { repo } = await enroll(auth);
    expect(repo.webhookManaged).toBe(true);
    expect((await newSecret(auth, repo.id)).status).toBe(200);
    const listed = await (await s.call("/api/auto-review/repos", { headers: auth })).json();
    expect(listed).toMatchObject({ repos: [{ id: repo.id, webhookManaged: false }] });

    const before = calls.length;
    const res = await s.call(`/api/auto-review/repos/${repo.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(await res.json()).toEqual({ removed: true });
    expect(calls.slice(before).map((c) => c.method)).toEqual([]);
    expect(hooks).toHaveLength(1);
  });

  it("gets a new secret only for the account that enrolled the project", async () => {
    const first = await s.signIn(1);
    const second = await s.signIn(2);
    const { repo, webhook } = await enroll(first.auth);
    const theirs = await newSecret(second.auth, repo.id);
    expect(theirs.status).toBe(404);
    expect(await delivers(webhook.secret)).toBe(true);
    const audit = await (await s.call("/api/audit", { headers: first.auth })).text();
    expect(audit).not.toContain("auto_review.webhook_secret_rotated");
  });

  it("is set up only by the account that enrolled the project", async () => {
    const first = await s.signIn(1);
    const second = await s.signIn(2);
    const { repo } = await enroll(first.auth);
    const before = calls.length;
    const theirs = await setUp(second.auth, repo.id);
    expect(theirs.status).toBe(404);
    expect(calls).toHaveLength(before);
  });
});

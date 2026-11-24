import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditPage } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's title and description edited, and the pull request
// closed or reopened, from its page as the signed-in user: an edit of a
// field someone changed since the page read it is refused, never sent.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;
const hub = { platform: "github", repo: "octo/api", number: 7 };
const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };

type Sent = { method: string; url: string; body: Record<string, unknown> };
type Signed = Awaited<ReturnType<typeof signInWithGithub>>;

function platform(routes: Record<string, () => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      if (req.method !== "GET") {
        const text = await req.text();
        sent.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : {} });
      }
      return route();
    },
  });
  return sent;
}

const post = (a: Signed, path: string, body: unknown) =>
  a.send(`/api/pulls/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const audited = async (a: Signed) => {
  const log = (await (await a.send("/api/audit")).json()) as AuditPage;
  return log.events
    .filter((e) => ["pull.details_edited", "pull.closed", "pull.reopened"].includes(e.kind))
    .map((e) => ({ kind: e.kind, ...e.detail }));
};

const githubPull = (over: Record<string, unknown> = {}) =>
  Response.json({
    node_id: "PR_7",
    title: "Fix the cache",
    body: "It was stale.\r\nNow it is not.",
    state: "open",
    merged_at: null,
    head: { sha: "a".repeat(40) },
    ...over,
  });

const gitlabMr = (over: Record<string, unknown> = {}) =>
  Response.json({ title: "Fix the cache", description: null, state: "opened", ...over });

async function gitlabSignedIn() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

describe("editing a GitHub pull request's title and description", () => {
  it("sends only what changed, while each still reads as the page saw it, and audits it", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => githubPull(),
      [`PATCH ${PULL}`]: () => githubPull({ title: "Fix the cache, again" }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "details", {
      ...hub,
      title: { from: "Fix the cache", to: "Fix the cache, again" },
      // The browser's form wrote the line ending as \n; the text is the same.
      body: { from: "It was stale.\nNow it is not.", to: "It was stale.\nNow it is not." },
    });
    expect(await answer(res)).toEqual({ status: 200, body: { outcome: "done" } });
    expect(sent).toEqual([{ method: "PATCH", url: PULL, body: { title: "Fix the cache, again" } }]);
    expect(await audited(a)).toEqual([
      { kind: "pull.details_edited", pull: "octo/api#7", fields: ["title", "body"] },
    ]);
  });

  it("refuses as stale, unsent, a title someone changed since the page read it", async () => {
    const sent = platform({ [`GET ${PULL}`]: () => githubPull({ title: "Fix the cache (v2)" }) });
    const a = await signInWithGithub();
    const res = await post(a, "details", {
      ...hub,
      title: { from: "Fix the cache", to: "Mine" },
    });
    expect(await answer(res)).toEqual({ status: 409, body: { error: "stale" } });
    expect(sent).toEqual([]);
    expect(await audited(a)).toEqual([]);
  });

  it("sends and audits nothing when every field already reads as asked", async () => {
    const sent = platform({ [`GET ${PULL}`]: () => githubPull() });
    const a = await signInWithGithub();
    const same = { from: "Fix the cache", to: "Fix the cache" };
    expect(await answer(await post(a, "details", { ...hub, title: same }))).toEqual({
      status: 200,
      body: { outcome: "done" },
    });
    expect(sent).toEqual([]);
    expect(await audited(a)).toEqual([]);
  });

  it("answers GitHub's 404 as not_found and its 403 and 422 as refused", async () => {
    let status = 422;
    platform({
      [`GET ${PULL}`]: () => githubPull(),
      [`PATCH ${PULL}`]: () => Response.json({ message: "no" }, { status }),
    });
    const a = await signInWithGithub();
    const edit = { ...hub, title: { from: "Fix the cache", to: "Other" } };
    expect(await answer(await post(a, "details", edit))).toEqual({
      status: 200,
      body: { outcome: "refused" },
    });
    status = 403;
    expect(await (await post(a, "details", edit)).json()).toEqual({ outcome: "refused" });
    status = 404;
    expect((await post(a, "details", edit)).status).toBe(404);
    status = 409;
    expect((await post(a, "details", edit)).status).toBe(409);
    expect(await audited(a)).toEqual([]);
  });

  it("refuses unsent an empty title, one with a line break, or nothing to change", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    for (const body of [
      { ...hub, title: { from: "x", to: "  " } },
      { ...hub, title: { from: "x", to: "a\nb" } },
      { ...hub, title: { from: "x", to: "y".repeat(256) } },
      hub,
    ]) {
      expect((await post(a, "details", body)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("closing and reopening a GitHub pull request", () => {
  it("closes an open one and reopens a closed one, each audited", async () => {
    let state = "open";
    const sent = platform({
      [`GET ${PULL}`]: () => githubPull({ state }),
      [`PATCH ${PULL}`]: () => githubPull(),
    });
    const a = await signInWithGithub();
    expect(await (await post(a, "state", { ...hub, state: "closed" })).json()).toEqual({
      outcome: "done",
    });
    state = "closed";
    expect(await (await post(a, "state", { ...hub, state: "open" })).json()).toEqual({
      outcome: "done",
    });
    expect(sent.map((s) => s.body)).toEqual([{ state: "closed" }, { state: "open" }]);
    expect(await audited(a)).toEqual([
      { kind: "pull.reopened", pull: "octo/api#7" },
      { kind: "pull.closed", pull: "octo/api#7" },
    ]);
  });

  it("sends nothing for a merged one, or one already so", async () => {
    let over: Record<string, unknown> = { state: "closed", merged_at: "2026-11-20T10:00:00Z" };
    const sent = platform({ [`GET ${PULL}`]: () => githubPull(over) });
    const a = await signInWithGithub();
    expect(await (await post(a, "state", { ...hub, state: "open" })).json()).toEqual({
      outcome: "refused",
    });
    over = {};
    expect(await (await post(a, "state", { ...hub, state: "open" })).json()).toEqual({
      outcome: "done",
    });
    expect(sent).toEqual([]);
    expect(await audited(a)).toEqual([]);
  });

  it("answers a pull request GitHub does not show the user as not_found", async () => {
    platform({ [`GET ${PULL}`]: () => Response.json({ message: "Not Found" }, { status: 404 }) });
    const a = await signInWithGithub();
    const res = await post(a, "state", { ...hub, state: "closed" });
    expect(await answer(res)).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("editing a GitLab merge request", () => {
  it("writes the description GitLab's way, while it still reads as the page saw it", async () => {
    const sent = platform({
      [`GET ${MR}`]: () => gitlabMr(),
      [`PUT ${MR}`]: () => gitlabMr(),
    });
    const a = await gitlabSignedIn();
    const res = await post(a, "details", { ...lab, body: { from: "", to: "Why it changed." } });
    expect(await answer(res)).toEqual({ status: 200, body: { outcome: "done" } });
    expect(sent).toEqual([{ method: "PUT", url: MR, body: { description: "Why it changed." } }]);
    expect(await audited(a)).toEqual([
      { kind: "pull.details_edited", pull: "Group/Sub/Project#3", fields: ["body"] },
    ]);
  });

  it("refuses as stale, unsent, a description someone wrote since", async () => {
    const sent = platform({ [`GET ${MR}`]: () => gitlabMr({ description: "Theirs." }) });
    const a = await gitlabSignedIn();
    const res = await post(a, "details", { ...lab, body: { from: "", to: "Mine." } });
    expect(await answer(res)).toEqual({ status: 409, body: { error: "stale" } });
    expect(sent).toEqual([]);
  });

  it("answers GitLab's 403 as refused", async () => {
    platform({
      [`GET ${MR}`]: () => gitlabMr(),
      [`PUT ${MR}`]: () => Response.json({ message: "403 Forbidden" }, { status: 403 }),
    });
    const a = await gitlabSignedIn();
    const res = await post(a, "details", { ...lab, title: { from: "Fix the cache", to: "New" } });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(await audited(a)).toEqual([]);
  });
});

describe("closing and reopening a GitLab merge request", () => {
  it("sends GitLab's state events, and nothing for a merged or locked one", async () => {
    let state = "opened";
    const sent = platform({
      [`GET ${MR}`]: () => gitlabMr({ state }),
      [`PUT ${MR}`]: () => gitlabMr(),
    });
    const a = await gitlabSignedIn();
    const set = async (to: string) =>
      ((await (await post(a, "state", { ...lab, state: to })).json()) as { outcome: string })
        .outcome;
    expect(await set("closed")).toBe("done");
    state = "closed";
    expect(await set("open")).toBe("done");
    state = "merged";
    expect(await set("open")).toBe("refused");
    state = "locked";
    expect(await set("closed")).toBe("refused");
    expect(sent.map((s) => s.body)).toEqual([{ state_event: "close" }, { state_event: "reopen" }]);
    expect(await audited(a)).toEqual([
      { kind: "pull.reopened", pull: "Group/Sub/Project#3" },
      { kind: "pull.closed", pull: "Group/Sub/Project#3" },
    ]);
  });
});

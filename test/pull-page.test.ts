import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineCounts, withinBudget } from "../src/platforms/changes.js";
import type { PullFilesView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's page: the diff read as the user, and their comment,
// review and merge sent to the platform as them, with its refusals answered.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const BASE = "c".repeat(40);
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;

type Sent = { method: string; url: string; body: unknown };

/** Answers the routes given, by method and URL, and records every write. */
function platform(routes: Record<string, (body: unknown) => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const key = `${req.method} ${req.url}`;
      const route = routes[key];
      if (!route) return undefined;
      const body = req.method === "GET" ? null : await req.json();
      if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body });
      return route(body);
    },
  });
  return sent;
}

const post = (
  send: (p: string, i?: RequestInit) => Promise<Response>,
  path: string,
  body: unknown,
) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ref = { platform: "github", repo: "octo/api", number: 7 };

describe("a pull request's files", () => {
  it("answers each file's diff and what the platform lets the user do", async () => {
    platform({
      [`GET ${PULL}`]: () =>
        Response.json({
          title: "Cap refunds at the order total",
          user: { login: "ada" },
          html_url: "https://github.com/octo/api/pull/7",
          base: { sha: BASE },
          head: { sha: HEAD },
          changed_files: 2,
        }),
      [`GET ${PULL}/files?per_page=100&page=1`]: () =>
        Response.json([
          {
            filename: "src/refund.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
          { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
        ]),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/files?platform=github&repo=octo/api&number=7");
    expect(res.status).toBe(200);
    const view = (await res.json()) as PullFilesView;
    expect(view).toMatchObject({
      title: "Cap refunds at the order total",
      author: "ada",
      url: "https://github.com/octo/api/pull/7",
      base: BASE,
      head: HEAD,
      truncated: false,
    });
    expect(view.files).toEqual([
      {
        path: "src/refund.ts",
        oldPath: "src/refund.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
        viewed: null,
      },
      {
        path: "logo.png",
        oldPath: "logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: null,
      },
    ]);
    expect(view.verdicts).toEqual(["approve", "request_changes", "comment"]);
    expect(view.mergeMethods).toEqual(["merge", "squash", "rebase"]);
  });

  it("offers only a comment on a merged or closed pull request", async () => {
    const answers = [
      { state: "closed", merged: true },
      { state: "closed", merged: false },
      { state: "open", merged: false },
    ];
    platform({
      [`GET ${PULL}`]: () =>
        Response.json({
          ...answers.shift(),
          base: { sha: BASE },
          head: { sha: HEAD },
          changed_files: 0,
        }),
    });
    const a = await signInWithGithub();
    const views = [];
    for (let i = 0; i < 3; i++) {
      const res = await a.send("/api/pulls/files?platform=github&repo=octo/api&number=7");
      const { state, verdicts, mergeMethods } = (await res.json()) as PullFilesView;
      views.push({ state, verdicts, mergeMethods });
    }
    expect(views).toEqual([
      { state: "merged", verdicts: ["comment"], mergeMethods: [] },
      { state: "closed", verdicts: ["comment"], mergeMethods: [] },
      {
        state: "open",
        verdicts: ["approve", "request_changes", "comment"],
        mergeMethods: ["merge", "squash", "rebase"],
      },
    ]);
  });

  it("refuses a repository path that is not one", async () => {
    platform({});
    const a = await signInWithGithub();
    for (const repo of ["../octo", "octo", "octo/..", "octo/api?x=1"]) {
      const res = await a.send(
        `/api/pulls/files?platform=github&repo=${encodeURIComponent(repo)}&number=7`,
      );
      expect(res.status).toBe(404);
    }
  });

  it("drops the diffs past the page's budget and says it is truncated", () => {
    const file = (path: string, patch: string) => ({
      path,
      oldPath: path,
      status: "modified" as const,
      ...lineCounts(patch),
      patch,
      version: null,
    });
    const cut = withinBudget(
      {
        title: null,
        author: null,
        url: null,
        state: null,
        base: BASE,
        head: HEAD,
        updatedAt: null,
        truncated: false,
        files: [file("a", "@@\n+1234"), file("b", "@@\n+56789"), file("c", "@@\n+0")],
      },
      12,
    );
    expect(cut.files.map((f) => f.patch)).toEqual(["@@\n+1234", null, null]);
    expect(cut.files[1]?.additions).toBe(1);
    expect(cut.truncated).toBe(true);
  });

  it("counts a diff's lines without its file headers", () => {
    expect(lineCounts("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n ctx")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});

describe("acting on a GitHub pull request", () => {
  it("approves the commit the user saw, with comments on the new and the old side", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => Response.json({ head: { sha: HEAD } }),
      [`POST ${PULL}/reviews`]: () => Response.json({ id: 1 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/review", {
      ...ref,
      verdict: "approve",
      body: "Looks right.",
      head: HEAD,
      comments: [
        { path: "src/refund.ts", line: 12, side: "new", body: "Cap this." },
        { path: "src/refund.ts", line: 9, side: "old", body: "Why removed?" },
      ],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${PULL}/reviews`,
        body: {
          commit_id: HEAD,
          event: "APPROVE",
          body: "Looks right.",
          comments: [
            { path: "src/refund.ts", line: 12, side: "RIGHT", body: "Cap this." },
            { path: "src/refund.ts", line: 9, side: "LEFT", body: "Why removed?" },
          ],
        },
      },
    ]);
  });

  it("sends no verdict on a pull request that moved since the page was read", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => Response.json({ head: { sha: MOVED } }),
      [`POST ${PULL}/reviews`]: () => Response.json({ id: 1 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/review", {
      ...ref,
      verdict: "request_changes",
      head: HEAD,
    });
    expect(await res.json()).toEqual({ outcome: "head_moved" });
    expect(sent).toEqual([]);
  });

  it("merges the head the user saw, and names why GitHub would not", async () => {
    const answers = [
      new Response(JSON.stringify({ merged: true }), { status: 200 }),
      new Response("{}", { status: 405 }),
      new Response("{}", { status: 409 }),
      new Response("{}", { status: 403 }),
    ];
    const sent = platform({ [`PUT ${PULL}/merge`]: () => answers.shift() as Response });
    const a = await signInWithGithub();
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const res = await post(a.send, "/api/pulls/merge", { ...ref, method: "squash", head: HEAD });
      outcomes.push(((await res.json()) as { outcome: string }).outcome);
    }
    expect(outcomes).toEqual(["done", "not_mergeable", "head_moved", "refused"]);
    expect(sent[0]?.body).toEqual({ merge_method: "squash", sha: HEAD });
  });

  it("comments on the conversation, and answers a refusal as one", async () => {
    const answers = [new Response("{}", { status: 201 }), new Response("{}", { status: 403 })];
    const sent = platform({
      "POST https://api.github.com/repos/octo/api/issues/7/comments": () =>
        answers.shift() as Response,
    });
    const a = await signInWithGithub();
    const first = await post(a.send, "/api/pulls/comment", { ...ref, body: "Thanks!" });
    const second = await post(a.send, "/api/pulls/comment", { ...ref, body: "Again" });
    expect(await first.json()).toEqual({ outcome: "done" });
    expect(await second.json()).toEqual({ outcome: "refused" });
    expect(sent[0]?.body).toEqual({ body: "Thanks!" });
  });

  it("says the platform was not reached when it does not answer", async () => {
    githubFake({
      extra: (req) => {
        if (req.url.endsWith("/merge")) throw new TypeError("network");
        return undefined;
      },
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/merge", { ...ref, method: "merge", head: HEAD });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unreachable" });
  });
});

describe("acting on a GitLab merge request", () => {
  const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };
  const refs = { base_sha: BASE, start_sha: BASE, head_sha: HEAD };

  it("posts each line comment as a discussion at its position, then the note, then approves", async () => {
    const sent = platform({
      [`GET ${MR}`]: () => Response.json({ sha: HEAD, diff_refs: refs }),
      [`POST ${MR}/discussions`]: () => new Response("{}", { status: 201 }),
      [`POST ${MR}/notes`]: () => new Response("{}", { status: 201 }),
      [`POST ${MR}/approve`]: () => Response.json({}),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const res = await post(a.send, "/api/pulls/review", {
      ...lab,
      verdict: "approve",
      body: "Ship it.",
      head: HEAD,
      comments: [{ path: "app.rb", line: 4, side: "new", body: "Nit." }],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => s.url)).toEqual([`${MR}/discussions`, `${MR}/notes`, `${MR}/approve`]);
    expect(sent[0]?.body).toEqual({
      body: "Nit.",
      position: {
        position_type: "text",
        ...refs,
        new_path: "app.rb",
        old_path: "app.rb",
        new_line: 4,
      },
    });
    expect(sent[2]?.body).toEqual({ sha: HEAD });
  });

  it("refuses a request for changes, which GitLab gives no client, without calling it", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const res = await post(a.send, "/api/pulls/review", {
      ...lab,
      verdict: "request_changes",
      head: HEAD,
    });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(sent).toEqual([]);
  });

  it("squashes on merge, and refuses a rebase GitLab does not merge with", async () => {
    const sent = platform({ [`PUT ${MR}/merge`]: () => Response.json({ state: "merged" }) });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const squash = await post(a.send, "/api/pulls/merge", { ...lab, method: "squash", head: HEAD });
    const rebase = await post(a.send, "/api/pulls/merge", { ...lab, method: "rebase", head: HEAD });
    expect(await squash.json()).toEqual({ outcome: "done" });
    expect(await rebase.json()).toEqual({ outcome: "refused" });
    expect(sent).toEqual([
      { method: "PUT", url: `${MR}/merge`, body: { sha: HEAD, squash: true } },
    ]);
  });
});

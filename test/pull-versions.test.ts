import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex, sha256Hex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { PullVersionCompareView, PullVersionsView } from "../src/shared/index.js";
import { db, request, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";
import { ask, gitlabHook } from "./restack-fakes.js";
import { rows } from "./table-rows.js";

// A pull request's versions: each head its webhooks said it was pushed to,
// with what the platform still lists (GitHub's force pushes, GitLab's diff
// versions), numbered from 1 with how each came after the one before; and
// the diff between any two, along the history or tree to tree after a
// force push.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SECRET = "pull-versions-secret";
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
const REPO = "https://api.github.com/repos/octo/api";

type Routes = Record<string, () => Response>;

function platform(routes: Routes) {
  const asked: string[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      asked.push(req.url);
      return route();
    },
  });
  return asked;
}

async function deliver(event: string, payload: unknown) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
  });
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
    }),
    env,
    ctx,
  );
  await res.text();
  await waitOnExecutionContext(ctx);
  expect(res.status).toBeLessThan(300);
}

const pushed = (action: string, head: string, at: string) => ({
  action,
  number: 7,
  pull_request: {
    number: 7,
    title: "Refunds",
    html_url: "https://github.com/octo/api/pull/7",
    state: "open",
    created_at: "2026-11-20T10:00:00Z",
    updated_at: at,
    user: { id: 5, login: "ada" },
    head: { sha: head, ref: "feat", repo: { id: 11 } },
    base: { ref: "main", repo: { id: 11 } },
  },
  repository: { id: 11, full_name: "octo/api" },
});

const timeline =
  (pushes: unknown[], totalCount = pushes.length) =>
  () =>
    Response.json({
      data: {
        repository: {
          pullRequest: {
            headRefOid: H3,
            commits: { nodes: [{ commit: { committedDate: "2026-11-22T09:00:00Z" } }] },
            timelineItems: { totalCount, nodes: pushes },
          },
        },
      },
    });
const forcePush = {
  createdAt: "2026-11-22T10:00:00Z",
  beforeCommit: { oid: H2, committedDate: "2026-11-21T09:00:00Z" },
  afterCommit: { oid: H3, committedDate: "2026-11-22T09:00:00Z" },
};
const pullAt = (head: string) => () =>
  Response.json({ base: { sha: "c".repeat(40) }, head: { sha: head }, changed_files: 1 });

async function enrolledOnGithub() {
  const a = await signInWithGithub();
  const [account] = await db.select().from(schema.accounts);
  const data = scoped(db, account?.id ?? "");
  await data.insert("reviewRepos", {
    ...rows.reviewRepos("r"),
    platformRepoId: "11",
    fullName: "octo/api",
  });
  return { a, data };
}

const versionsOf = (platformKind = "github", repo = "octo/api", number = 7) =>
  `/api/pulls/versions?platform=${platformKind}&repo=${repo}&number=${number}`;
const compareOf = (from: string, to: string) =>
  `/api/pulls/versions/compare?platform=github&repo=octo/api&number=7&from=${from}&to=${to}`;

describe("a pull request's versions on GitHub", () => {
  it("numbers each head its webhooks kept, once each, and says the force push GitHub names", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: pullAt(H3),
      "POST https://api.github.com/graphql": timeline([forcePush]),
    });
    const { a, data } = await enrolledOnGithub();
    await deliver("pull_request", pushed("opened", H1, "2026-11-20T10:00:00Z"));
    await deliver("pull_request", pushed("synchronize", H2, "2026-11-21T10:00:00Z"));
    // Delivered again, and an edit at the same head: still one version.
    await deliver("pull_request", pushed("synchronize", H2, "2026-11-21T11:00:00Z"));
    await deliver("pull_request", pushed("edited", H2, "2026-11-21T12:00:00Z"));
    await deliver("pull_request", pushed("synchronize", H3, "2026-11-22T10:00:00Z"));

    const res = await a.send(versionsOf());
    expect(res.status).toBe(200);
    expect((await res.json()) as PullVersionsView).toEqual({
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: H3,
      versions: [
        { version: 1, head: H1, pushedAt: "2026-11-20T10:00:00.000Z", kind: "first" },
        { version: 2, head: H2, pushedAt: "2026-11-21T10:00:00.000Z", kind: "fast_forward" },
        { version: 3, head: H3, pushedAt: "2026-11-22T10:00:00.000Z", kind: "rewrite" },
      ],
      complete: true,
    });
    expect((await data.list("pullVersions")).map((v) => v.head).sort()).toEqual([H1, H2, H3]);
  });

  it("lists the heads either side of GitHub's force pushes where no webhook kept them", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: pullAt(H3),
      "POST https://api.github.com/graphql": timeline([forcePush], 101),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(versionsOf())).json()) as PullVersionsView;
    expect(view.complete).toBe(false);
    // Past the force pushes read, GitHub may have rewritten others: no kind is said.
    expect(view.versions).toEqual([
      { version: 1, head: H2, pushedAt: null, kind: null },
      { version: 2, head: H3, pushedAt: "2026-11-22T10:00:00.000Z", kind: "rewrite" },
    ]);
    // A pull request the user cannot read is not found.
    expect((await a.send(versionsOf("github", "octo/api", 8))).status).toBe(404);
  });
});

describe("comparing two versions on GitHub", () => {
  const changedFile = {
    filename: "src/refund.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: "@@ -1 +1,2 @@\n-a\n+b\n+c",
    sha: "f".repeat(40),
  };

  it("compares along the history when the older head is an ancestor", async () => {
    const asked = platform({
      [`GET ${REPO}/pulls/7`]: pullAt(H3),
      [`GET ${REPO}/compare/${H1}...${H2}`]: () =>
        Response.json({ status: "ahead", files: [changedFile] }),
    });
    const a = await signInWithGithub();
    const view = (await (
      await a.send(compareOf(H1, H2.toUpperCase()))
    ).json()) as PullVersionCompareView;
    expect(view).toEqual({
      platform: "github",
      repo: "octo/api",
      number: 7,
      from: H1,
      to: H2,
      state: "changes",
      compare: "history",
      lines: true,
      files: [
        {
          path: "src/refund.ts",
          oldPath: "src/refund.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-a\n+b\n+c",
          viewed: null,
        },
      ],
      truncated: false,
    });
    // A head that is no sha is refused before the platform is asked.
    const before = asked.length;
    expect((await a.send(compareOf("main", H2))).status).toBe(404);
    expect(asked).toHaveLength(before);
  });

  it("compares the two trees after a force push, naming the files that differ", async () => {
    const blob = (c: string) => c.repeat(40);
    const asked = platform({
      [`GET ${REPO}/pulls/7`]: pullAt(H3),
      [`GET ${REPO}/compare/${H2}...${H3}`]: () =>
        Response.json({ status: "diverged", files: [changedFile] }),
      [`GET ${REPO}/git/commits/${H2}`]: () => Response.json({ tree: { sha: blob("a") } }),
      [`GET ${REPO}/git/commits/${H3}`]: () => Response.json({ tree: { sha: blob("b") } }),
      [`GET ${REPO}/git/trees/${blob("a")}?recursive=1`]: () =>
        Response.json({
          tree: [
            { path: "src", type: "tree", sha: blob("d") },
            { path: "src/kept.ts", type: "blob", sha: blob("e") },
            { path: "src/refund.ts", type: "blob", sha: blob("f") },
            { path: "src/gone.ts", type: "blob", sha: blob("9") },
          ],
          truncated: false,
        }),
      [`GET ${REPO}/git/trees/${blob("b")}?recursive=1`]: () =>
        Response.json({
          tree: [
            { path: "src", type: "tree", sha: blob("8") },
            { path: "src/kept.ts", type: "blob", sha: blob("e") },
            { path: "src/refund.ts", type: "blob", sha: blob("7") },
            { path: "src/new.ts", type: "blob", sha: blob("6") },
          ],
          truncated: false,
        }),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(compareOf(H2, H3))).json()) as PullVersionCompareView;
    expect(view).toMatchObject({
      state: "changes",
      compare: "trees",
      lines: false,
      truncated: false,
    });
    expect(view.files.map((f) => [f.path, f.status, f.patch])).toEqual([
      ["src/gone.ts", "removed", null],
      ["src/new.ts", "added", null],
      ["src/refund.ts", "modified", null],
    ]);
    expect(asked).toContain(`${REPO}/git/trees/${blob("b")}?recursive=1`);
  });

  it("says same for one head, and unavailable when GitHub cannot compare", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: pullAt(H3),
      [`GET ${REPO}/compare/${H1}...${H3}`]: () => Response.json({}, { status: 404 }),
    });
    const a = await signInWithGithub();
    expect(await (await a.send(compareOf(H1, H1))).json()).toMatchObject({
      state: "same",
      compare: null,
      files: [],
    });
    expect(await (await a.send(compareOf(H1, H3))).json()).toMatchObject({
      state: "unavailable",
      compare: null,
    });
  });
});

describe("a merge request's versions on GitLab", () => {
  const FULL_NAME = "Group/Sub/Project";
  const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent(FULL_NAME)}`;
  const MR = `${PROJECT}/merge_requests/3`;
  const HOOK_SECRET = "s".repeat(32);
  const mr = () => Response.json({ diff_refs: { base_sha: H1, start_sha: H1, head_sha: H3 } });

  async function enrolledOnGitlab() {
    const a = await signInWithGithub();
    expect((await (await connectGitlab(a))("code=c&state=STATE")).status).toBe(302);
    const [account] = await db.select().from(schema.accounts);
    const data = scoped(db, account?.id ?? "");
    await data.insert("reviewRepos", {
      ...rows.reviewRepos("r"),
      platform: "gitlab" as const,
      host: new URL(GITLAB).host,
      platformRepoId: "9",
      fullName: FULL_NAME,
      webhookSecretHash: await sha256Hex(HOOK_SECRET),
    });
    return { a, data };
  }

  const hook = (action: string, head: string, at: string, oldrev?: string) => ({
    object_kind: "merge_request",
    project: { id: 9, path_with_namespace: FULL_NAME },
    object_attributes: {
      id: 103,
      iid: 3,
      title: "Refunds",
      url: `${GITLAB}/${FULL_NAME}/-/merge_requests/3`,
      state: "opened",
      action,
      source_branch: "feat",
      target_branch: "main",
      source_project_id: 9,
      target_project_id: 9,
      updated_at: at,
      last_commit: { id: head },
      ...(oldrev ? { oldrev } : {}),
    },
  });

  it("keeps the pushes its hooks say, and numbers them as GitLab's versions list them", async () => {
    platform({
      [`GET ${MR}`]: mr,
      [`GET ${MR}/versions?per_page=100`]: () =>
        Response.json([
          { head_commit_sha: H3, created_at: "2026-11-22T10:00:00Z" },
          { head_commit_sha: H2, created_at: "2026-11-21T10:00:00Z" },
          { head_commit_sha: H1, created_at: "2026-11-20T10:00:00Z" },
        ]),
    });
    const { a, data } = await enrolledOnGitlab();
    for (const body of [
      hook("open", H1, "2026-11-20 10:00:00 UTC"),
      hook("update", H2, "2026-11-21 10:00:00 UTC", H1),
      // A title edit: no new commits, no new version.
      hook("update", H2, "2026-11-21 11:00:00 UTC"),
    ]) {
      expect((await gitlabHook(HOOK_SECRET, body)).status).toBe(202);
    }

    const res = await ask(a, versionsOf("gitlab", FULL_NAME, 3));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PullVersionsView).versions).toEqual([
      { version: 1, head: H1, pushedAt: "2026-11-20T10:00:00.000Z", kind: "first" },
      { version: 2, head: H2, pushedAt: "2026-11-21T10:00:00.000Z", kind: null },
      { version: 3, head: H3, pushedAt: "2026-11-22T10:00:00.000Z", kind: null },
    ]);
    const kept = await data.list("pullVersions");
    expect(kept.map((v) => [v.head, v.pushedAt.toISOString(), v.opened]).sort()).toEqual([
      [H1, "2026-11-20T10:00:00.000Z", true],
      [H2, "2026-11-21T10:00:00.000Z", false],
    ]);
  });

  it("answers from the kept pushes alone when GitLab's versions fail", async () => {
    platform({
      [`GET ${MR}`]: mr,
      [`GET ${MR}/versions?per_page=100`]: () => Response.json({}, { status: 500 }),
    });
    const { a } = await enrolledOnGitlab();
    await gitlabHook(HOOK_SECRET, hook("open", H1, "2026-11-20 10:00:00 UTC"));
    const view = (await (
      await ask(a, versionsOf("gitlab", FULL_NAME, 3))
    ).json()) as PullVersionsView;
    expect(view).toMatchObject({ head: H3, complete: true });
    expect(view.versions.map((v) => [v.version, v.head, v.kind])).toEqual([
      [1, H1, "first"],
      [2, H3, null],
    ]);
  });

  it("compares a rebased version straight to the other, tree to tree", async () => {
    const asked = platform({
      [`GET ${MR}`]: mr,
      [`GET ${PROJECT}/repository/merge_base?refs[]=${H2}&refs[]=${H3}`]: () =>
        Response.json({ id: H1 }),
      [`GET ${PROJECT}/repository/compare?from=${H2}&to=${H3}&straight=true`]: () =>
        Response.json({
          diffs: [
            {
              old_path: "app.rb",
              new_path: "app.rb",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
              diff: "@@ -1 +1 @@\n-a\n+b\n",
            },
          ],
        }),
    });
    const { a } = await enrolledOnGitlab();
    const res = await ask(
      a,
      `/api/pulls/versions/compare?platform=gitlab&repo=${FULL_NAME}&number=3&from=${H2}&to=${H3}`,
    );
    const view = (await res.json()) as PullVersionCompareView;
    expect(view).toMatchObject({ state: "changes", compare: "trees", lines: true });
    expect(view.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([["app.rb", 1, 1]]);
    expect(asked).toContain(`${PROJECT}/repository/compare?from=${H2}&to=${H3}&straight=true`);
  });
});

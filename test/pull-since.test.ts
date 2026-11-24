import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullSinceView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// What changed since the head the user last reviewed or saw: the diff from
// it to the current head, read as the user, with a force push said as such.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const REVIEWED = "d".repeat(40);
const SEEN = "e".repeat(40);
const REPO = "https://api.github.com/repos/octo/api";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;
const MR = `${PROJECT}/merge_requests/3`;

type Routes = Record<string, (body: unknown) => Response>;

/** Answers the routes given, by method and URL, and records every URL asked. */
function platform(routes: Routes) {
  const asked: string[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      asked.push(req.url);
      return route(req.method === "GET" ? null : await req.json());
    },
  });
  return asked;
}

const pull = { base: { sha: BASE }, head: { sha: HEAD }, changed_files: 1 };
const reviewOf =
  (oid: string | null, state = "APPROVED") =>
  () =>
    Response.json({
      data: {
        repository: {
          pullRequest: {
            viewerLatestReview: oid
              ? { state, submittedAt: "2026-11-20T10:00:00Z", commit: { oid } }
              : null,
          },
        },
      },
    });
const changedFile = {
  filename: "src/refund.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  changes: 3,
  patch: "@@ -1 +1,2 @@\n-a\n+b\n+c",
  sha: "f".repeat(40),
};

async function markSeen(send: (p: string, i?: RequestInit) => Promise<Response>, head: string) {
  const res = await send("/api/pulls/seen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "github",
      repo: "Octo/API",
      number: 7,
      updatedAt: "2026-11-19T10:00:00Z",
      head,
    }),
  });
  expect(res.status).toBe(200);
}

const since = (query = "") => `/api/pulls/since?platform=github&repo=octo/api&number=7${query}`;

describe("changes since the last review on GitHub", () => {
  it("leaves out whitespace-only changes when asked", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED),
      [`GET ${REPO}/compare/${REVIEWED}...${HEAD}`]: () =>
        Response.json({
          status: "ahead",
          files: [{ ...changedFile, patch: "@@ -1 +1,2 @@\n-a\n+ a \n+c" }],
        }),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(since("&whitespace=ignore"))).json()) as PullSinceView;
    expect(view.files.map((f) => [f.patch, f.additions, f.deletions])).toEqual([
      ["@@ -1,1 +1,2 @@\n  a \n+c", 1, 0],
    ]);
  });

  it("compares from the reviewed head by default, and offers the read mark's too", async () => {
    const asked = platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED),
      [`GET ${REPO}/compare/${REVIEWED}...${HEAD}`]: () =>
        Response.json({ status: "ahead", files: [changedFile] }),
    });
    const a = await signInWithGithub();
    await markSeen(a.send, SEEN);
    const res = await a.send(since());
    expect(res.status).toBe(200);
    expect((await res.json()) as PullSinceView).toEqual({
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: HEAD,
      since: REVIEWED,
      state: "changes",
      options: [
        { source: "reviewed", head: REVIEWED, at: "2026-11-20T10:00:00Z" },
        { source: "seen", head: SEEN, at: expect.any(String) },
      ],
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
    expect(asked).toContain(`${REPO}/compare/${REVIEWED}...${HEAD}`);
  });

  it("compares from the head asked for, written in any case", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED),
      [`GET ${REPO}/compare/${SEEN}...${HEAD}`]: () =>
        Response.json({ status: "ahead", files: [changedFile] }),
    });
    const a = await signInWithGithub();
    const view = (await (
      await a.send(since(`&since=${SEEN.toUpperCase()}`))
    ).json()) as PullSinceView;
    expect(view).toMatchObject({ since: SEEN, state: "changes" });
    expect(view.files.map((f) => f.path)).toEqual(["src/refund.ts"]);
  });

  it("says rebased when a force push left the reviewed head out of the history", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED),
      [`GET ${REPO}/compare/${REVIEWED}...${HEAD}`]: () =>
        Response.json({ status: "diverged", files: [changedFile] }),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(since())).json()) as PullSinceView;
    expect(view).toMatchObject({ since: REVIEWED, state: "rebased", files: [] });
  });

  it("falls back to the read mark past a pending review, and says same at the current head", async () => {
    const asked = platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED, "PENDING"),
    });
    const a = await signInWithGithub();
    await markSeen(a.send, HEAD);
    const view = (await (await a.send(since())).json()) as PullSinceView;
    expect(view).toMatchObject({
      since: HEAD,
      state: "same",
      options: [{ source: "seen", head: HEAD }],
      files: [],
    });
    expect(asked.some((u) => u.includes("/compare/"))).toBe(false);
  });

  it("says none with nothing to compare from, and unavailable when the comparison fails", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(null),
      [`GET ${REPO}/compare/${SEEN}...${HEAD}`]: () => new Response(null, { status: 404 }),
    });
    const a = await signInWithGithub();
    const none = (await (await a.send(since())).json()) as PullSinceView;
    expect(none).toMatchObject({ since: null, state: "none", options: [], files: [] });
    const gone = (await (await a.send(since(`&since=${SEEN}`))).json()) as PullSinceView;
    expect(gone).toMatchObject({ since: SEEN, state: "unavailable", files: [] });
  });

  it("says truncated when GitHub's comparison lists its 300 files", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ ...changedFile, filename: `f${i}.ts` }));
    platform({
      [`GET ${REPO}/pulls/7`]: () => Response.json(pull),
      "POST https://api.github.com/graphql": reviewOf(REVIEWED),
      [`GET ${REPO}/compare/${REVIEWED}...${HEAD}`]: () =>
        Response.json({ status: "ahead", files }),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(since())).json()) as PullSinceView;
    expect(view).toMatchObject({ state: "changes", truncated: true });
    expect(view.files).toHaveLength(300);
  });

  it("refuses a since that is no sha, before asking the platform", async () => {
    const asked = platform({});
    const a = await signInWithGithub();
    for (const bad of ["abc", `${HEAD}/../x`, `${"g".repeat(40)}`, "HEAD~1"]) {
      const res = await a.send(since(`&since=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(404);
    }
    expect(asked).toEqual([]);
  });
});

describe("changes since the last review on GitLab", () => {
  const lab = "/api/pulls/since?platform=gitlab&repo=Group/Sub/Project&number=3";
  const mr = () =>
    Response.json({ diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD } });
  const notes = () =>
    Response.json([
      {
        author: { id: 77 },
        system: true,
        body: "added 1 commit",
        created_at: "2026-11-21T09:00:00Z",
      },
      { author: { id: 5 }, system: false, body: "Looks fine", created_at: "2026-11-20T12:00:00Z" },
      {
        author: { id: 77 },
        system: true,
        body: "approved this merge request",
        created_at: "2026-11-20T10:00:00Z",
      },
    ]);
  const versions = () =>
    Response.json([
      { head_commit_sha: HEAD, created_at: "2026-11-21T09:00:00Z" },
      { head_commit_sha: REVIEWED, created_at: "2026-11-19T09:00:00Z" },
      { head_commit_sha: SEEN, created_at: "2026-11-18T09:00:00Z" },
    ]);
  const diff = {
    old_path: "app.rb",
    new_path: "app.rb",
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  };

  it("compares from the version the user approved, along its history", async () => {
    const asked = platform({
      [`GET ${MR}`]: mr,
      [`GET ${MR}/notes?sort=desc&order_by=created_at&per_page=100`]: notes,
      [`GET ${MR}/versions?per_page=100`]: versions,
      [`GET ${PROJECT}/repository/merge_base?refs[]=${REVIEWED}&refs[]=${HEAD}`]: () =>
        Response.json({ id: REVIEWED }),
      [`GET ${PROJECT}/repository/compare?from=${REVIEWED}&to=${HEAD}&straight=true`]: () =>
        Response.json({ diffs: [diff] }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = (await (await a.send(lab)).json()) as PullSinceView;
    expect(view).toMatchObject({
      platform: "gitlab",
      head: HEAD,
      since: REVIEWED,
      state: "changes",
      options: [{ source: "reviewed", head: REVIEWED, at: "2026-11-20T10:00:00Z" }],
      truncated: false,
    });
    expect(view.files).toEqual([
      {
        path: "app.rb",
        oldPath: "app.rb",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        viewed: null,
      },
    ]);
    expect(asked).toContain(
      `${PROJECT}/repository/compare?from=${REVIEWED}&to=${HEAD}&straight=true`,
    );
  });

  it("takes a diff comment's own head, and says rebased off the current history", async () => {
    const asked = platform({
      [`GET ${MR}`]: mr,
      [`GET ${MR}/notes?sort=desc&order_by=created_at&per_page=100`]: () =>
        Response.json([
          {
            author: { id: 77 },
            system: false,
            body: "Nit.",
            created_at: "2026-11-20T10:00:00Z",
            position: { head_sha: SEEN },
          },
        ]),
      [`GET ${PROJECT}/repository/merge_base?refs[]=${SEEN}&refs[]=${HEAD}`]: () =>
        Response.json({ id: BASE }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = (await (await a.send(lab)).json()) as PullSinceView;
    expect(view).toMatchObject({ since: SEEN, state: "rebased", files: [] });
    expect(asked.some((u) => u.includes("/versions") || u.includes("/compare"))).toBe(false);
  });
});

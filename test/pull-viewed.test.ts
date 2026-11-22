import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { MAX_VIEWED_PATHS, type PullFilesView } from "../src/shared/index.js";
import { db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// Files ticked as viewed on a pull request's page: GitHub's own state,
// read and set through GraphQL, and for GitLab the console's, which counts
// only while the file's diff is the one ticked.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const BASE = "c".repeat(40);
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const GRAPHQL = "https://api.github.com/graphql";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;

type Route = (body: { query?: string; variables?: Record<string, unknown> } | null) => Response;

/** Answers the routes given, by method and URL, and records every body sent. */
function platform(routes: Record<string, Route>) {
  const sent: { url: string; body: { query?: string; variables?: Record<string, unknown> } }[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const body = req.method === "GET" ? null : await req.json();
      if (body) sent.push({ url: req.url, body: body as never });
      return route(body as never);
    },
  });
  return sent;
}

const post = (a: { send: (p: string, i?: RequestInit) => Promise<Response> }, body: unknown) =>
  a.send("/api/pulls/viewed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const viewedOf = async (res: Response) =>
  Object.fromEntries(((await res.json()) as PullFilesView).files.map((f) => [f.path, f.viewed]));

describe("a GitHub pull request's viewed files", () => {
  const ref = { platform: "github", repo: "octo/api", number: 7 };
  const file = (filename: string) => ({
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1 +1,2 @@\n a\n+b",
  });

  it("reads GitHub's own state, a file changed since its tick reading as not viewed", async () => {
    const pages: unknown[] = [];
    platform({
      [`GET ${PULL}`]: () =>
        Response.json({ base: { sha: BASE }, head: { sha: HEAD }, changed_files: 4 }),
      [`GET ${PULL}/files?per_page=100&page=1`]: () =>
        Response.json(["a.ts", "b.ts", "c.ts", "d.ts"].map(file)),
      [`POST ${GRAPHQL}`]: (body) => {
        pages.push(body?.variables?.after);
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                files:
                  body?.variables?.after === null
                    ? {
                        pageInfo: { hasNextPage: true, endCursor: "C1" },
                        nodes: [
                          { path: "a.ts", viewerViewedState: "VIEWED" },
                          { path: "b.ts", viewerViewedState: "DISMISSED" },
                        ],
                      }
                    : {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ path: "c.ts", viewerViewedState: "UNVIEWED" }],
                      },
              },
            },
          },
        });
      },
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/files?platform=github&repo=octo/api&number=7");
    expect(pages).toEqual([null, "C1"]);
    // d.ts was on no page GitHub answered: not said.
    expect(await viewedOf(res)).toEqual({
      "a.ts": true,
      "b.ts": false,
      "c.ts": false,
      "d.ts": null,
    });
  });

  it("still lists the files when GitHub does not say which were viewed", async () => {
    platform({
      [`GET ${PULL}`]: () =>
        Response.json({ base: { sha: BASE }, head: { sha: HEAD }, changed_files: 1 }),
      [`GET ${PULL}/files?per_page=100&page=1`]: () => Response.json([file("a.ts")]),
      [`POST ${GRAPHQL}`]: () => new Response(null, { status: 502 }),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/files?platform=github&repo=octo/api&number=7");
    expect(res.status).toBe(200);
    expect(await viewedOf(res)).toEqual({ "a.ts": null });
  });

  it("ticks files with one GraphQL document at the head the page read, and keeps nothing", async () => {
    let head = HEAD;
    const sent = platform({
      [`POST ${GRAPHQL}`]: (body) =>
        body?.query?.startsWith("mutation")
          ? Response.json({ data: {} })
          : Response.json({
              data: { repository: { pullRequest: { id: "PR_kw", headRefOid: head } } },
            }),
    });
    const a = await signInWithGithub();
    const res = await post(a, {
      ...ref,
      head: HEAD,
      paths: ["a.ts", "b.ts", "a.ts"],
      viewed: true,
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    const mutation = sent[1]?.body;
    expect(mutation?.query).toContain(
      "f0: markFileAsViewed(input: { pullRequestId: $id, path: $p0 })",
    );
    expect(mutation?.query).toContain("f1: markFileAsViewed");
    expect(mutation?.query).not.toContain("f2:");
    expect(mutation?.variables).toEqual({ id: "PR_kw", p0: "a.ts", p1: "b.ts" });
    expect(await db.select().from(schema.pullFileViews)).toEqual([]);

    const off = await post(a, { ...ref, head: HEAD, paths: ["a.ts"], viewed: false });
    expect(await off.json()).toEqual({ outcome: "done" });
    expect(sent[3]?.body.query).toContain("f0: unmarkFileAsViewed");

    head = NEXT;
    const moved = await post(a, { ...ref, head: HEAD, paths: ["a.ts"], viewed: true });
    expect(await moved.json()).toEqual({ outcome: "head_moved" });
    expect(sent).toHaveLength(5);
  });

  it("answers GitHub's errors as refused, and an unreachable GitHub as such", async () => {
    let reachable = true;
    platform({
      [`POST ${GRAPHQL}`]: (body) =>
        !reachable
          ? new Response(null, { status: 502 })
          : body?.query?.startsWith("mutation")
            ? Response.json({ data: null, errors: [{ message: "no such path" }] })
            : Response.json({
                data: { repository: { pullRequest: { id: "PR_kw", headRefOid: HEAD } } },
              }),
    });
    const a = await signInWithGithub();
    const body = { ...ref, head: HEAD, paths: ["nope.ts"], viewed: true };
    expect(await (await post(a, body)).json()).toEqual({ outcome: "refused" });
    reachable = false;
    const res = await post(a, body);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unreachable" });
  });

  it("refuses a request with no paths or too many, or no head", async () => {
    platform({});
    const a = await signInWithGithub();
    const paths = Array.from({ length: MAX_VIEWED_PATHS + 1 }, (_, i) => `f${i}.ts`);
    for (const body of [
      { ...ref, head: HEAD, paths: [], viewed: true },
      { ...ref, head: HEAD, paths, viewed: true },
      { ...ref, paths: ["a.ts"], viewed: true },
      { ...ref, head: HEAD, paths: [""], viewed: true },
    ]) {
      expect((await post(a, body)).status).toBe(400);
    }
  });
});

describe("a GitLab merge request's viewed files", () => {
  const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };
  const diff = (path: string, text: string) => ({
    old_path: path,
    new_path: path,
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    diff: text,
  });

  /** The merge request at `now.head` with `now.diffs`, as the test changes them. */
  function mergeRequest(now: { head: string; diffs: ReturnType<typeof diff>[] }) {
    platform({
      [`GET ${MR}`]: () =>
        Response.json({
          title: "Cap refunds",
          author: { username: "ada" },
          web_url: "https://gitlab.example.com/group/sub/project/-/merge_requests/3",
          diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: now.head },
        }),
      [`GET ${MR}/diffs?per_page=100&page=1`]: () => Response.json(now.diffs),
    });
  }

  async function signInToGitlab() {
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    return a;
  }

  const files = (a: Awaited<ReturnType<typeof signInToGitlab>>) =>
    a.send(`/api/pulls/files?platform=gitlab&repo=${encodeURIComponent(lab.repo)}&number=3`);

  it("keeps a tick until the file changes in a later head", async () => {
    const now = {
      head: HEAD,
      diffs: [diff("app.rb", "@@ -1 +1 @@\n-a\n+b"), diff("lib/x.rb", "@@ -1 +1 @@\n-c\n+d")],
    };
    mergeRequest(now);
    const a = await signInToGitlab();
    expect(await (await files(a)).clone().json()).toMatchObject({
      title: "Cap refunds",
      author: "ada",
      url: "https://gitlab.example.com/group/sub/project/-/merge_requests/3",
    });
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": false, "lib/x.rb": false });

    const res = await post(a, { ...lab, head: HEAD, paths: ["app.rb", "lib/x.rb"], viewed: true });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": true, "lib/x.rb": true });
    const kept = await db.select().from(schema.pullFileViews);
    expect(kept.map((r) => [r.platform, r.repo, r.number, r.path])).toEqual([
      ["gitlab", "group/sub/project", 3, "app.rb"],
      ["gitlab", "group/sub/project", 3, "lib/x.rb"],
    ]);

    // A new head that changes app.rb only.
    now.head = NEXT;
    now.diffs = [diff("app.rb", "@@ -1 +1 @@\n-a\n+e"), diff("lib/x.rb", "@@ -1 +1 @@\n-c\n+d")];
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": false, "lib/x.rb": true });

    const again = await post(a, { ...lab, head: NEXT, paths: ["app.rb"], viewed: true });
    expect(await again.json()).toEqual({ outcome: "done" });
    expect(await db.select().from(schema.pullFileViews)).toHaveLength(2);
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": true, "lib/x.rb": true });

    const off = await post(a, { ...lab, head: NEXT, paths: ["lib/x.rb"], viewed: false });
    expect(await off.json()).toEqual({ outcome: "done" });
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": true, "lib/x.rb": false });
  });

  it("clears a tick on a file whose diff GitLab did not send at every new head", async () => {
    const now = { head: HEAD, diffs: [diff("big.json", "")] };
    mergeRequest(now);
    const a = await signInToGitlab();
    await post(a, { ...lab, head: HEAD, paths: ["big.json"], viewed: true });
    expect(await viewedOf(await files(a))).toEqual({ "big.json": true });
    now.head = NEXT;
    expect(await viewedOf(await files(a))).toEqual({ "big.json": false });
  });

  it("ticks nothing on a merge request that moved, or a path that is not one of its files", async () => {
    const now = { head: NEXT, diffs: [diff("app.rb", "@@ -1 +1 @@\n-a\n+b")] };
    mergeRequest(now);
    const a = await signInToGitlab();
    const moved = await post(a, { ...lab, head: HEAD, paths: ["app.rb"], viewed: true });
    expect(await moved.json()).toEqual({ outcome: "head_moved" });
    const stray = await post(a, { ...lab, head: NEXT, paths: ["app.rb", "x.rb"], viewed: true });
    expect(await stray.json()).toEqual({ outcome: "refused" });
    expect(await db.select().from(schema.pullFileViews)).toEqual([]);
  });

  it("keeps each account's ticks to itself", async () => {
    mergeRequest({ head: HEAD, diffs: [diff("app.rb", "@@ -1 +1 @@\n-a\n+b")] });
    const a = await signInToGitlab();
    await post(a, { ...lab, head: HEAD, paths: ["app.rb"], viewed: true });
    const [mine] = await db.select().from(schema.pullFileViews);
    const other = await signIn(2, "other");
    const pull = { platform: "gitlab" as const, repo: "group/sub/project", number: 3 };
    expect((await scoped(db, other.account.id).pullFileViews.versions(pull)).size).toBe(0);

    // Another account's tick of the same file, at the same version, and its untick, leave mine.
    const theirs = scoped(db, other.account.id).pullFileViews;
    await theirs.mark(pull, [{ path: "app.rb", sha: mine?.sha ?? "" }]);
    await theirs.unmark(pull, ["app.rb"]);
    expect(await db.select().from(schema.pullFileViews)).toEqual([mine]);
    expect(await viewedOf(await files(a))).toEqual({ "app.rb": true });
  });
});

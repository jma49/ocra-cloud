import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullThreadsView } from "../src/shared/index.js";
import { seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// A GitHub pull request's review threads on its page: listed with the
// suggestions GitHub would apply, applied as one commit of the head the
// user saw, resolved and reopened, and suggestions written into a review.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const GRAPHQL = "https://api.github.com/graphql";
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const CONTENTS = "https://api.github.com/repos/octo/api/contents/src/db.ts";
const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
const ref = { platform: "github", repo: "octo/api", number: 7 };

type Sent = { method: string; url: string; body: { query?: string } & Record<string, unknown> };

function platform(routes: Record<string, (body: Sent["body"]) => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const body = (req.method === "GET" ? {} : await req.json()) as Sent["body"];
      sent.push({ method: req.method, url: req.url, body });
      return route(body);
    },
  });
  return sent;
}

const comment = (id: string, body: string, hunk: string) => ({
  id,
  author: { login: "rev" },
  body,
  createdAt: "2026-11-20T10:00:00Z",
  diffHunk: hunk,
});

const thread = (over: Record<string, unknown>, comments: ReturnType<typeof comment>[]) => ({
  id: "T1",
  isResolved: false,
  isOutdated: false,
  path: "src/db.ts",
  line: 2,
  startLine: null,
  originalLine: 2,
  originalStartLine: null,
  diffSide: "RIGHT",
  startDiffSide: null,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: { totalCount: comments.length, nodes: comments },
  ...over,
});

const HUNK = "@@ -1,4 +1,4 @@\n const a = 1;\n-const b = 1;\n+const b = 2;";
const THREADS = [
  thread({}, [comment("C1", "Bigger.\n```suggestion\nconst b = 20;\n```", HUNK)]),
  thread({ id: "T2", line: 4, startLine: 3, originalLine: 4, originalStartLine: 3 }, [
    comment("C2", "```suggestion\nconst cd = 34;\n```", `${HUNK}\n const c = 3;\n const d = 4;`),
  ]),
  thread({ id: "T3", isOutdated: true, line: null, originalLine: 9 }, [
    comment("C3", "```suggestion\nold\n```", "@@ -9 +9 @@\n+x"),
  ]),
  thread({ id: "T4", path: "src/other.ts", isResolved: true, viewerCanUnresolve: true }, [
    comment("C4", "```suggestion\na\n```\n```suggestion\nb\n```", HUNK),
  ]),
];

const listed = (head = HEAD, threads: unknown[] = THREADS) =>
  Response.json({
    data: {
      repository: {
        pullRequest: {
          headRefOid: head,
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
        },
      },
    },
  });

const graphql =
  (head = HEAD, mutated: () => Response = () => Response.json({ data: {} })) =>
  (body: Sent["body"]) =>
    body.query?.startsWith("mutation") ? mutated() : listed(head);

const fileRead =
  (text = FILE) =>
  () =>
    Response.json({
      type: "file",
      sha: "blob1",
      size: text.length,
      encoding: "base64",
      content: btoa(text),
    });

const post = (a: Awaited<ReturnType<typeof signInWithGithub>>, path: string, body: unknown) =>
  a.send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const pullAt =
  (sha = HEAD) =>
  () =>
    Response.json({ head: { sha, ref: "feature", repo: { full_name: "octo/api" } } });

describe("a GitHub pull request's threads", () => {
  it("lists threads with their suggestions, and which of them can be applied", async () => {
    platform({ [`POST ${GRAPHQL}`]: graphql() });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/threads?platform=github&repo=octo/api&number=7");
    const view = (await res.json()) as PullThreadsView;
    expect(view.head).toBe(HEAD);
    expect(view.truncated).toBe(false);
    const [one, range, outdated, resolved] = view.threads;
    expect(one).toMatchObject({ id: "T1", line: 2, side: "new", canResolve: true });
    expect(one?.comments[0]?.suggestions).toEqual([
      {
        id: "C1:0",
        startLine: 2,
        endLine: 2,
        replacement: "const b = 20;",
        applicable: true,
        applied: false,
      },
    ]);
    expect(range?.comments[0]?.suggestions[0]).toMatchObject({ startLine: 3, endLine: 4 });
    // An outdated suggestion is shown, but its lines are gone.
    expect(outdated).toMatchObject({ outdated: true, line: null });
    expect(outdated?.comments[0]?.suggestions[0]).toMatchObject({ applicable: false });
    // GitHub applies a comment's suggestion only when it is its only one.
    expect(resolved).toMatchObject({ resolved: true, canResolve: true });
    expect(resolved?.comments[0]?.suggestions.map((s) => s.applicable)).toEqual([false, false]);
  });

  it("applies suggestions on one file as one commit of the head the user saw", async () => {
    const sent = platform({
      [`POST ${GRAPHQL}`]: graphql(),
      [`GET ${PULL}`]: pullAt(),
      [`GET ${CONTENTS}?ref=${HEAD}`]: fileRead(),
      [`PUT ${CONTENTS}`]: () => Response.json({ commit: { sha: MOVED } }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...ref,
      head: HEAD,
      suggestions: ["C1:0", "C2:0"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    const puts = sent.filter((s) => s.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(atob(String(puts[0]?.body.content))).toBe(
      "const a = 1;\nconst b = 20;\nconst cd = 34;\n",
    );
    expect(puts[0]?.body).toMatchObject({
      sha: "blob1",
      branch: "feature",
      message: "Apply 2 suggestions from review",
    });
  });

  it("commits nothing on a pull request that moved since the page read it", async () => {
    const sent = platform({ [`POST ${GRAPHQL}`]: graphql(MOVED) });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...ref,
      head: HEAD,
      suggestions: ["C1:0"],
    });
    expect(await res.json()).toEqual({ outcome: "head_moved" });
    expect(sent.filter((s) => s.method !== "POST")).toEqual([]);
  });

  it("commits nothing when the lines changed since the comment", async () => {
    const sent = platform({
      [`POST ${GRAPHQL}`]: graphql(),
      [`GET ${PULL}`]: pullAt(),
      [`GET ${CONTENTS}?ref=${HEAD}`]: fileRead(FILE.replace("const b = 2;", "const b = 3;")),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...ref,
      head: HEAD,
      suggestions: ["C1:0"],
    });
    expect(await res.json()).toEqual({ outcome: "not_applicable" });
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
  });

  it("applies no outdated suggestion, none of another pull request, nor several files at once", async () => {
    const sent = platform({ [`POST ${GRAPHQL}`]: graphql() });
    const a = await signInWithGithub();
    const apply = async (suggestions: string[]) =>
      (await post(a, "/api/pulls/apply-suggestions", { ...ref, head: HEAD, suggestions })).json();
    expect(await apply(["C3:0"])).toEqual({ outcome: "not_applicable" });
    expect(await apply(["ELSEWHERE:0"])).toEqual({ outcome: "not_applicable" });
    // Both applicable, but on two files: the contents API commits one.
    const other = thread({ id: "T5", path: "src/other.ts" }, [
      comment("C5", "```suggestion\nx\n```", HUNK),
    ]);
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
    vi.restoreAllMocks();
    const later = platform({ [`POST ${GRAPHQL}`]: () => listed(HEAD, [...THREADS, other]) });
    expect(await apply(["C1:0", "C5:0"])).toEqual({ outcome: "refused" });
    expect(later.filter((s) => s.method === "PUT")).toEqual([]);
  });

  it("refuses a request that names a suggestion twice or none", async () => {
    platform({});
    const a = await signInWithGithub();
    const apply = (suggestions: string[]) =>
      post(a, "/api/pulls/apply-suggestions", { ...ref, head: HEAD, suggestions });
    expect((await apply([])).status).toBe(400);
    expect((await apply(["C1:0", "C1:0"])).status).toBe(400);
    expect((await apply(["../x"])).status).toBe(400);
  });

  it("resolves and reopens a thread of this pull request through GraphQL", async () => {
    const sent = platform({ [`POST ${GRAPHQL}`]: graphql() });
    const a = await signInWithGithub();
    const resolve = (thread: string, resolved: boolean) =>
      post(a, "/api/pulls/resolve-thread", { ...ref, thread, resolved });
    expect(await (await resolve("T1", true)).json()).toEqual({ outcome: "done" });
    expect(await (await resolve("T4", false)).json()).toEqual({ outcome: "done" });
    const mutations = sent.filter((s) => s.body.query?.startsWith("mutation"));
    expect(mutations.map((m) => [m.body.query?.includes("unresolve"), m.body.variables])).toEqual([
      [false, { id: "T1" }],
      [true, { id: "T4" }],
    ]);
    // Thread ids are global: one this pull request has not is not sent.
    expect(await (await resolve("OTHER", true)).json()).toEqual({ outcome: "refused" });
    // T2 is open and the viewer may resolve it, but not reopen what is not resolved.
    expect(await (await resolve("T2", false)).json()).toEqual({ outcome: "done" });
    expect(sent.filter((s) => s.body.query?.startsWith("mutation"))).toHaveLength(2);
  });

  it("refuses unsent a resolve GitHub says the viewer may not make", async () => {
    const sent = platform({
      [`POST ${GRAPHQL}`]: () => listed(HEAD, [thread({ viewerCanResolve: false }, [])]),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/resolve-thread", {
      ...ref,
      thread: "T1",
      resolved: true,
    });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(sent.filter((s) => s.body.query?.startsWith("mutation"))).toEqual([]);
  });

  it("answers GitHub's refusal to resolve as one", async () => {
    platform({
      [`POST ${GRAPHQL}`]: graphql(HEAD, () =>
        Response.json({ data: null, errors: [{ type: "FORBIDDEN" }] }),
      ),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/resolve-thread", {
      ...ref,
      thread: "T1",
      resolved: true,
    });
    expect(await res.json()).toEqual({ outcome: "refused" });
  });
});

describe("what the threads' actions record of ocra's findings", () => {
  const FP = "0123456789abcdef";
  const ocraThreads = (resolved = false) => [
    thread({ isResolved: resolved, viewerCanUnresolve: true }, [
      comment(
        "C1",
        `<!-- ocra:finding ${FP} -->\nBigger.\n\`\`\`suggestion\nconst b = 20;\n\`\`\``,
        HUNK,
      ),
      comment("C9", `<!-- ocra:finding ${"f".repeat(16)} -->\nA reply quoting another.`, HUNK),
    ]),
  ];

  it("marks the finding of the comment whose suggestion was applied fixed via suggestion", async () => {
    platform({
      [`POST ${GRAPHQL}`]: () => listed(HEAD, ocraThreads()),
      [`GET ${PULL}`]: pullAt(),
      [`GET ${CONTENTS}?ref=${HEAD}`]: fileRead(),
      [`PUT ${CONTENTS}`]: () => Response.json({ commit: { sha: MOVED } }),
    });
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/Octo/api", 7, { fingerprint: FP });
    const other = await seed("https://github.com/octo/api", 8, { fingerprint: FP }, "run-2");
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...ref,
      head: HEAD,
      suggestions: ["C1:0"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(await data.get("findings", id)).toMatchObject({
      status: "fixed",
      fixedVia: "suggestion",
    });
    // The same fingerprint on another pull request is another finding.
    expect(await data.get("findings", other.id)).toMatchObject({ status: "open", fixedVia: null });
    // Marked by hand afterwards, it keeps how it was fixed.
    await data.decide([id], { status: "fixed", reason: null, note: null, decidedAt: new Date() });
    expect((await data.get("findings", id))?.fixedVia).toBe("suggestion");
  });

  it("marks nothing when the commit was not made", async () => {
    platform({ [`POST ${GRAPHQL}`]: () => listed(MOVED, ocraThreads()) });
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...ref,
      head: HEAD,
      suggestions: ["C1:0"],
    });
    expect(await res.json()).toEqual({ outcome: "head_moved" });
    expect(await data.get("findings", id)).toMatchObject({ status: "open", fixedVia: null });
  });

  it("records the thread of ocra's comment resolved, and clears it when reopened", async () => {
    let resolved = false;
    platform({
      [`POST ${GRAPHQL}`]: (body) => {
        if (!body.query?.startsWith("mutation")) return listed(HEAD, ocraThreads(resolved));
        resolved = !body.query.includes("unresolve");
        return Response.json({ data: {} });
      },
    });
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7, { fingerprint: FP });
    const resolve = (to: boolean) =>
      post(a, "/api/pulls/resolve-thread", { ...ref, thread: "T1", resolved: to });
    expect(await (await resolve(true)).json()).toEqual({ outcome: "done" });
    const first = (await data.get("findings", id))?.threadResolvedAt;
    expect(first).toBeInstanceOf(Date);
    // Resolving it again keeps when it was first resolved; the open finding is addressed.
    expect(await (await resolve(true)).json()).toEqual({ outcome: "done" });
    expect(await data.get("findings", id)).toMatchObject({
      status: "addressed",
      threadResolvedAt: first,
    });
    expect(await (await resolve(false)).json()).toEqual({ outcome: "done" });
    expect(await data.get("findings", id)).toMatchObject({
      status: "open",
      threadResolvedAt: null,
    });
  });
});

describe("writing a suggestion into a GitHub review", () => {
  it("sends a range comment with its suggestion block", async () => {
    const sent = platform({
      [`GET ${PULL}`]: () => Response.json({ head: { sha: HEAD } }),
      [`POST ${PULL}/reviews`]: () => Response.json({ id: 1 }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/review", {
      ...ref,
      verdict: "comment",
      head: HEAD,
      comments: [
        { path: "src/db.ts", line: 4, startLine: 3, side: "new", suggestion: "const cd = 34;" },
      ],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.at(-1)?.body.comments).toEqual([
      {
        path: "src/db.ts",
        line: 4,
        side: "RIGHT",
        start_line: 3,
        start_side: "RIGHT",
        body: "```suggestion\nconst cd = 34;\n```",
      },
    ]);
  });

  it("refuses a suggestion on removed lines, a backwards range, or one too long, unsent", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    const review = (c: Record<string, unknown>) =>
      post(a, "/api/pulls/review", {
        ...ref,
        verdict: "comment",
        head: HEAD,
        comments: [{ path: "src/db.ts", line: 4, side: "new", ...c }],
      });
    expect((await review({ side: "old", suggestion: "x" })).status).toBe(400);
    expect((await review({ startLine: 5, body: "x" })).status).toBe(400);
    expect((await review({ startLine: 1, line: 200, suggestion: "x" })).status).toBe(400);
    expect((await review({ suggestion: "x\n".repeat(300) })).status).toBe(400);
    expect((await review({ body: " " })).status).toBe(400);
    expect(sent).toEqual([]);
  });
});

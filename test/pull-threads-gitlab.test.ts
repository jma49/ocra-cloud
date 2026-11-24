import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullThreadsView } from "../src/shared/index.js";
import { seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A GitLab merge request's diff discussions on its page: listed with the
// suggestions GitLab read in them, applied through its suggestion API as the
// user, resolved and reopened, and suggestions written into a review.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const OLD = "d".repeat(40);
const MOVED = "b".repeat(40);
const BASE = "c".repeat(40);
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;
const SUGGESTIONS = `${GITLAB}/api/v4/suggestions`;
const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };
const refs = { base_sha: BASE, start_sha: BASE, head_sha: HEAD };

type Sent = { method: string; url: string; body: unknown };

function platform(routes: Record<string, () => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      if (req.method !== "GET")
        sent.push({ method: req.method, url: req.url, body: await req.json() });
      return route();
    },
  });
  return sent;
}

const position = (over: Record<string, unknown> = {}) => ({
  head_sha: HEAD,
  new_path: "app.rb",
  old_path: "app.rb",
  new_line: 4,
  old_line: null,
  ...over,
});

const suggestion = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  from_line: 4,
  to_line: 4,
  appliable: true,
  applied: false,
  from_content: "x = 1\n",
  to_content: "x = 2\n",
  ...over,
});

const note = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  type: "DiffNote",
  body: "```suggestion\nx = 2\n```",
  author: { username: "rev" },
  created_at: "2026-11-20T10:00:00Z",
  system: false,
  resolvable: true,
  resolved: false,
  position: position(),
  suggestions: [suggestion(id * 10)],
  ...over,
});

const DISCUSSIONS = [
  { id: "d1".padEnd(40, "0"), notes: [note(1)] },
  {
    id: "d2".padEnd(40, "0"),
    notes: [
      note(2, {
        position: position({ new_line: 9, line_range: { start: { new_line: 7 } } }),
        suggestions: [suggestion(20, { from_line: 7, to_line: 9 })],
      }),
      note(3, { type: "DiscussionNote", body: "Agreed.", suggestions: [] }),
      note(4, { system: true, body: "changed this line" }),
    ],
  },
  {
    id: "d3".padEnd(40, "0"),
    notes: [note(5, { position: position({ head_sha: OLD }), resolved: true })],
  },
  // A discussion on the conversation, not the diff, is not a review thread.
  { id: "d4".padEnd(40, "0"), notes: [{ ...note(6), type: null, position: null }] },
];

const routesAt = (sha = HEAD) => ({
  [`GET ${MR}`]: () => Response.json({ sha, diff_refs: { ...refs, head_sha: sha } }),
  [`GET ${MR}/discussions?per_page=100&page=1`]: () => Response.json(DISCUSSIONS),
});

const post = (a: Awaited<ReturnType<typeof signInWithGithub>>, path: string, body: unknown) =>
  a.send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function signedIn() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

describe("a GitLab merge request's threads", () => {
  it("lists diff discussions with GitLab's suggestions, an outdated one shown but not applicable", async () => {
    platform(routesAt());
    const a = await signedIn();
    const res = await a.send(`/api/pulls/threads?platform=gitlab&repo=Group/Sub/Project&number=3`);
    const view = (await res.json()) as PullThreadsView;
    expect(view.head).toBe(HEAD);
    expect(view.threads.map((t) => t.id.slice(0, 2))).toEqual(["d1", "d2", "d3"]);
    const [one, range, outdated] = view.threads;
    expect(one).toMatchObject({ path: "app.rb", line: 4, startLine: null, side: "new" });
    expect(one?.comments[0]?.suggestions).toEqual([
      {
        id: "10",
        startLine: 4,
        endLine: 4,
        replacement: "x = 2",
        applicable: true,
        applied: false,
      },
    ]);
    expect(range).toMatchObject({ line: 9, startLine: 7 });
    expect(range?.comments.map((c) => c.body)).toEqual(["```suggestion\nx = 2\n```", "Agreed."]);
    expect(outdated).toMatchObject({ outdated: true, line: null, resolved: true });
    expect(outdated?.comments[0]?.suggestions[0]?.applicable).toBe(false);
  });

  it("reads a bounded number of pages of a merge request with many other discussions", async () => {
    const pages: number[] = [];
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`.padEnd(40, "0"),
      notes: [{ ...note(i), type: null, position: null }],
    }));
    const routes: Record<string, () => Response> = { ...routesAt() };
    for (let page = 1; page <= 30; page++) {
      routes[`GET ${MR}/discussions?per_page=100&page=${page}`] = () => {
        pages.push(page);
        return Response.json(page === 30 ? DISCUSSIONS : comments);
      };
    }
    platform(routes);
    const a = await signedIn();
    const res = await a.send(`/api/pulls/threads?platform=gitlab&repo=Group/Sub/Project&number=3`);
    const view = (await res.json()) as PullThreadsView;
    expect(pages.length).toBeLessThanOrEqual(10);
    expect(view).toMatchObject({ threads: [], truncated: true });
  });

  it("applies one suggestion, or several in one batch, through GitLab's suggestion API", async () => {
    const sent = platform({
      ...routesAt(),
      [`PUT ${SUGGESTIONS}/10/apply`]: () => Response.json({}),
      [`PUT ${SUGGESTIONS}/batch_apply`]: () => Response.json([]),
    });
    const a = await signedIn();
    const apply = async (suggestions: string[]) =>
      (await post(a, "/api/pulls/apply-suggestions", { ...lab, head: HEAD, suggestions })).json();
    expect(await apply(["10"])).toEqual({ outcome: "done" });
    expect(await apply(["10", "20"])).toEqual({ outcome: "done" });
    expect(sent).toEqual([
      { method: "PUT", url: `${SUGGESTIONS}/10/apply`, body: {} },
      { method: "PUT", url: `${SUGGESTIONS}/batch_apply`, body: { ids: [10, 20] } },
    ]);
  });

  it("applies nothing on a merge request that moved, or an outdated suggestion", async () => {
    const sent = platform(routesAt(MOVED));
    const a = await signedIn();
    const apply = async (suggestions: string[]) =>
      (await post(a, "/api/pulls/apply-suggestions", { ...lab, head: HEAD, suggestions })).json();
    expect(await apply(["10"])).toEqual({ outcome: "head_moved" });
    expect(sent).toEqual([]);
    vi.restoreAllMocks();
    const later = platform(routesAt());
    expect(await apply(["50"])).toEqual({ outcome: "not_applicable" });
    // A suggestion of another merge request is not one of this listing's.
    expect(await apply(["999"])).toEqual({ outcome: "not_applicable" });
    expect(later).toEqual([]);
  });

  it("answers GitLab's refusal of a suggestion whose lines changed as not applicable", async () => {
    platform({
      ...routesAt(),
      [`PUT ${SUGGESTIONS}/10/apply`]: () =>
        Response.json({ message: "A suggestion is not applicable." }, { status: 400 }),
    });
    const a = await signedIn();
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...lab,
      head: HEAD,
      suggestions: ["10"],
    });
    expect(await res.json()).toEqual({ outcome: "not_applicable" });
  });

  it("resolves and reopens a discussion", async () => {
    const d1 = "d1".padEnd(40, "0");
    const sent = platform({ [`PUT ${MR}/discussions/${d1}`]: () => Response.json({}) });
    const a = await signedIn();
    const resolve = async (resolved: boolean) =>
      (await post(a, "/api/pulls/resolve-thread", { ...lab, thread: d1, resolved })).json();
    expect(await resolve(true)).toEqual({ outcome: "done" });
    expect(await resolve(false)).toEqual({ outcome: "done" });
    expect(sent.map((s) => s.body)).toEqual([{ resolved: true }, { resolved: false }]);
  });
});

describe("what a GitLab discussion's actions record of ocra's findings", () => {
  const FP = "0123456789abcdef";
  const d1 = "d1".padEnd(40, "0");
  const ocra = note(1, { body: `<!-- ocra:finding ${FP} -->\n\`\`\`suggestion\nx = 2\n\`\`\`` });
  const seeded = () => seed("https://gitlab.example.com/group/sub/project", 3, { fingerprint: FP });

  it("marks the finding of the note whose suggestion was applied fixed via suggestion", async () => {
    platform({
      [`GET ${MR}`]: () => Response.json({ sha: HEAD, diff_refs: refs }),
      [`GET ${MR}/discussions?per_page=100&page=1`]: () =>
        Response.json([{ id: d1, notes: [ocra] }]),
      [`PUT ${SUGGESTIONS}/10/apply`]: () => Response.json({}),
    });
    const a = await signedIn();
    const { id, data } = await seeded();
    const res = await post(a, "/api/pulls/apply-suggestions", {
      ...lab,
      head: HEAD,
      suggestions: ["10"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(await data.get("findings", id)).toMatchObject({
      status: "fixed",
      fixedVia: "suggestion",
    });
  });

  it("records the discussion GitLab answers resolved, from its first note", async () => {
    platform({
      [`PUT ${MR}/discussions/${d1}`]: () =>
        Response.json({ id: d1, notes: [{ ...ocra, resolved: true }] }),
    });
    const a = await signedIn();
    const { id, data } = await seeded();
    const res = await post(a, "/api/pulls/resolve-thread", { ...lab, thread: d1, resolved: true });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(await data.get("findings", id)).toMatchObject({ status: "addressed" });
    expect((await data.get("findings", id))?.threadResolvedAt).toBeInstanceOf(Date);
  });
});

describe("writing a suggestion into a GitLab review", () => {
  it("anchors a range on its last line, with the lines above in the suggestion's fence", async () => {
    const sent = platform({
      [`GET ${MR}`]: () => Response.json({ sha: HEAD, diff_refs: refs }),
      [`POST ${MR}/discussions`]: () => new Response("{}", { status: 201 }),
    });
    const a = await signedIn();
    const res = await post(a, "/api/pulls/review", {
      ...lab,
      verdict: "comment",
      head: HEAD,
      comments: [
        {
          path: "app.rb",
          line: 9,
          startLine: 7,
          side: "new",
          body: "Simpler.",
          suggestion: "y = 3",
        },
      ],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent[0]?.body).toMatchObject({
      body: "Simpler.\n\n```suggestion:-2+0\ny = 3\n```",
      position: { new_line: 9 },
    });
  });
});

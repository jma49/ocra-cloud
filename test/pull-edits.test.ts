import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullDraftView, PullLabelsView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's page keeps common work in the console, as the signed-in
// user: a reply to a review thread, draft and ready, and its labels, on
// GitHub and on GitLab.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const GRAPHQL = "https://api.github.com/graphql";
const REPO = "https://api.github.com/repos/octo/api";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;
const hub = { platform: "github", repo: "octo/api", number: 7 };
const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };
const query = (r: typeof hub) => `platform=${r.platform}&repo=${r.repo}&number=${r.number}`;

type Sent = { method: string; url: string; body: Record<string, unknown> };

function platform(routes: Record<string, (body: Sent["body"]) => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const text = req.method === "GET" ? "" : await req.text();
      const body = (text ? JSON.parse(text) : {}) as Sent["body"];
      if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body });
      return route(body);
    },
  });
  return sent;
}

const post = (a: Awaited<ReturnType<typeof signInWithGithub>>, path: string, body: unknown) =>
  a.send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function onGitlab() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

const threadsListed = (ids: string[]) =>
  Response.json({
    data: {
      repository: {
        pullRequest: {
          headRefOid: "a".repeat(40),
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: ids.map((id) => ({
              id,
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
              comments: { totalCount: 0, nodes: [] },
            })),
          },
        },
      },
    },
  });

describe("replying to a review thread", () => {
  it("replies on GitHub through GraphQL, only to a thread of this pull request", async () => {
    const sent = platform({
      [`POST ${GRAPHQL}`]: (body) =>
        String(body.query).startsWith("mutation")
          ? Response.json({ data: { addPullRequestReviewThreadReply: { comment: { id: "C9" } } } })
          : threadsListed(["T1"]),
    });
    const a = await signInWithGithub();
    const reply = (thread: string) =>
      post(a, "/api/pulls/reply-thread", { ...hub, thread, body: "Fixed in the next push." });
    expect(await (await reply("T1")).json()).toEqual({ outcome: "done" });
    expect(await (await reply("OTHER")).json()).toEqual({ outcome: "refused" });
    const mutations = sent.filter((s) => String(s.body.query).startsWith("mutation"));
    expect(mutations.map((m) => m.body.variables)).toEqual([
      { id: "T1", body: "Fixed in the next push." },
    ]);
    expect(String(mutations[0]?.body.query)).toContain("addPullRequestReviewThreadReply");
  });

  it("answers GitHub's refusal of a reply as one", async () => {
    platform({
      [`POST ${GRAPHQL}`]: (body) =>
        String(body.query).startsWith("mutation")
          ? Response.json({ errors: [{ type: "FORBIDDEN" }] })
          : threadsListed(["T1"]),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/reply-thread", { ...hub, thread: "T1", body: "Ok." });
    expect(await res.json()).toEqual({ outcome: "refused" });
  });

  it("adds a note to a GitLab discussion of the merge request", async () => {
    const d1 = "d1".padEnd(40, "0");
    const sent = platform({
      [`POST ${MR}/discussions/${d1}/notes`]: () => Response.json({ id: 5 }, { status: 201 }),
      [`POST ${MR}/discussions/gone/notes`]: () => new Response("{}", { status: 404 }),
    });
    const a = await onGitlab();
    const reply = (thread: string) =>
      post(a, "/api/pulls/reply-thread", { ...lab, thread, body: "Agreed." });
    expect(await (await reply(d1)).json()).toEqual({ outcome: "done" });
    expect(await (await reply("gone")).json()).toEqual({ outcome: "refused" });
    expect(sent.map((s) => s.body)).toEqual([{ body: "Agreed." }, { body: "Agreed." }]);
  });

  it("refuses an empty reply unsent", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/reply-thread", { ...hub, thread: "T1", body: "  " });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("draft and ready for review", () => {
  const pull =
    (over: Record<string, unknown> = {}) =>
    () =>
      Response.json({ node_id: "PR_7", draft: true, state: "open", merged_at: null, ...over });

  it("marks a GitHub draft ready, and an open pull request a draft, through GraphQL", async () => {
    let draft = true;
    const sent = platform({
      [`GET ${REPO}/pulls/7`]: () => pull({ draft })(),
      [`POST ${GRAPHQL}`]: () => Response.json({ data: {} }),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(`/api/pulls/draft?${query(hub)}`)).json()) as PullDraftView;
    expect(view).toEqual({ draft: true, state: "open" });
    expect(await (await post(a, "/api/pulls/draft", { ...hub, draft: false })).json()).toEqual({
      outcome: "done",
    });
    draft = false;
    expect(await (await post(a, "/api/pulls/draft", { ...hub, draft: true })).json()).toEqual({
      outcome: "done",
    });
    expect(
      sent.map((s) => [String(s.body.query).match(/\{ (\w+)\(/)?.[1], s.body.variables]),
    ).toEqual([
      ["markPullRequestReadyForReview", { id: "PR_7" }],
      ["convertPullRequestToDraft", { id: "PR_7" }],
    ]);
  });

  it("sends nothing for a GitHub pull request already so, and refuses a closed one", async () => {
    let state = { draft: false, state: "open", merged_at: null as string | null };
    const sent = platform({
      [`GET ${REPO}/pulls/7`]: () => pull(state)(),
      [`POST ${GRAPHQL}`]: () => Response.json({ data: {} }),
    });
    const a = await signInWithGithub();
    const ready = () => post(a, "/api/pulls/draft", { ...hub, draft: false });
    expect(await (await ready()).json()).toEqual({ outcome: "done" });
    state = { draft: false, state: "closed", merged_at: "2026-11-20T10:00:00Z" };
    expect(await (await a.send(`/api/pulls/draft?${query(hub)}`)).json()).toEqual({
      draft: false,
      state: "merged",
    });
    expect(await (await post(a, "/api/pulls/draft", { ...hub, draft: true })).json()).toEqual({
      outcome: "refused",
    });
    expect(sent).toEqual([]);
  });

  it("sets a GitLab merge request's draft state through its title's prefix", async () => {
    let mr = { title: "[Draft] draft: Faster cache", state: "opened", draft: true };
    const sent = platform({
      [`GET ${MR}`]: () => Response.json(mr),
      [`PUT ${MR}`]: () => Response.json({}),
    });
    const a = await onGitlab();
    expect(await (await a.send(`/api/pulls/draft?${query(lab)}`)).json()).toEqual({
      draft: true,
      state: "open",
    });
    await post(a, "/api/pulls/draft", { ...lab, draft: false });
    mr = { title: "Faster cache", state: "opened", draft: false };
    await post(a, "/api/pulls/draft", { ...lab, draft: true });
    mr = { title: "Faster cache", state: "merged", draft: false };
    expect(await (await post(a, "/api/pulls/draft", { ...lab, draft: true })).json()).toEqual({
      outcome: "refused",
    });
    expect(sent.map((s) => s.body)).toEqual([
      { title: "Faster cache" },
      { title: "Draft: Faster cache" },
    ]);
  });
});

describe("a pull request's labels", () => {
  it("lists GitHub's labels on the pull request and the repository's to pick from", async () => {
    platform({
      [`GET ${REPO}/issues/7/labels?per_page=100`]: () => Response.json([{ name: "bug" }]),
      [`GET ${REPO}/labels?per_page=100`]: () =>
        Response.json([
          { name: "bug", color: "D73A4A", description: "Something is wrong" },
          { name: "docs", color: "not a colour", description: "" },
        ]),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(`/api/pulls/labels?${query(hub)}`)).json()) as PullLabelsView;
    expect(view).toEqual({
      applied: ["bug"],
      available: [
        { name: "bug", color: "#d73a4a", description: "Something is wrong" },
        { name: "docs", color: null, description: null },
      ],
      truncated: false,
    });
  });

  it("adds through GitHub's issue labels and removes only labels it has", async () => {
    const sent = platform({
      [`GET ${REPO}/issues/7/labels?per_page=100`]: () =>
        Response.json([{ name: "Needs Review" }, { name: "bug" }]),
      [`POST ${REPO}/issues/7/labels`]: () => Response.json([]),
      [`DELETE ${REPO}/issues/7/labels/Needs%20Review`]: () => Response.json([]),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/labels", {
      ...hub,
      add: ["ready"],
      remove: ["needs review", "absent"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", `${REPO}/issues/7/labels`, { labels: ["ready"] }],
      ["DELETE", `${REPO}/issues/7/labels/Needs%20Review`, {}],
    ]);
  });

  it("answers GitHub's refusal to add as one, and removes nothing after it", async () => {
    const sent = platform({
      [`GET ${REPO}/issues/7/labels?per_page=100`]: () => Response.json([{ name: "bug" }]),
      [`POST ${REPO}/issues/7/labels`]: () => new Response("{}", { status: 403 }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/labels", { ...hub, add: ["x"], remove: ["bug"] });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(sent.map((s) => s.method)).toEqual(["POST"]);
  });

  it("lists and changes a GitLab merge request's labels in one update", async () => {
    const sent = platform({
      [`GET ${MR}`]: () => Response.json({ title: "t", state: "opened", labels: ["backend"] }),
      [`GET ${PROJECT}/labels?per_page=100`]: () =>
        Response.json([{ name: "backend", color: "#1F75CB", description: null }]),
      [`PUT ${MR}`]: () => Response.json({}),
    });
    const a = await onGitlab();
    const view = (await (await a.send(`/api/pulls/labels?${query(lab)}`)).json()) as PullLabelsView;
    expect(view).toEqual({
      applied: ["backend"],
      available: [{ name: "backend", color: "#1f75cb", description: null }],
      truncated: false,
    });
    const res = await post(a, "/api/pulls/labels", {
      ...lab,
      add: ["ready", "p1"],
      remove: ["backend"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => s.body)).toEqual([{ add_labels: "ready,p1", remove_labels: "backend" }]);
  });

  it("refuses unsent an edit with nothing to change, a label twice, or a comma", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    for (const edit of [
      { add: [], remove: [] },
      { add: ["bug"], remove: ["Bug"] },
      { add: ["a,b"] },
    ]) {
      expect((await post(a, "/api/pulls/labels", { ...hub, ...edit })).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

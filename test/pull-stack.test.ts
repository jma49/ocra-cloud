import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullStackView, StackMergeView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's stack read from the platform as the user, and its merge
// from the bottom up, retargeting each to the trunk and stopping at the
// first refusal (ADR-0052).

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const REPO = "https://api.github.com/repos/octo/api";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;

type Sent = { method: string; url: string; body: unknown };

function platform(routes: Record<string, (body: unknown) => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url.split("?")[0]}`];
      if (!route) return undefined;
      const body = req.method === "GET" ? null : await req.json();
      if (req.method !== "GET" && !req.url.endsWith("/graphql")) {
        sent.push({ method: req.method, url: req.url, body });
      }
      return route(body);
    },
  });
  return sent;
}

const node = (number: number, head: string, base: string, extra = {}) => ({
  number,
  title: `Step ${number}`,
  url: `https://github.com/octo/api/pull/${number}`,
  isDraft: false,
  headRefName: head,
  baseRefName: base,
  headRefOid: sha(number),
  isCrossRepository: false,
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  ...extra,
});

const githubOpen = () => ({
  "POST https://api.github.com/graphql": () =>
    Response.json({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              node(3, "step-3", "step-2", { reviewDecision: "APPROVED" }),
              node(2, "step-2", "step-1"),
              node(1, "step-1", "main", {
                commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
              }),
              node(9, "step-2", "main", { isCrossRepository: true }),
            ],
          },
        },
      },
    }),
});

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

const ref = { platform: "github", repo: "octo/api" };
const heads = (...ns: number[]) => ns.map((n) => ({ number: n, head: sha(n) }));

describe("a GitHub pull request's stack", () => {
  it("lists the stack bottom to top from the open pull requests' branches, forks left out", async () => {
    platform(githubOpen());
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/stack?platform=github&repo=octo/api&number=2");
    expect(res.status).toBe(200);
    const view = (await res.json()) as PullStackView;
    expect(view.trunk).toBe("main");
    expect(view.pulls.map((p) => [p.number, p.parent, p.base])).toEqual([
      [1, null, "main"],
      [2, 1, "step-1"],
      [3, 2, "step-2"],
    ]);
    expect(view.pulls[0]).toMatchObject({ checks: "passing", headSha: sha(1) });
    expect(view.pulls[2]).toMatchObject({ review: "approved" });
  });

  it("merges from the bottom, retargeting each one above to the trunk first", async () => {
    const sent = platform({
      ...githubOpen(),
      [`PATCH ${REPO}/pulls/2`]: () => Response.json({}),
      [`PUT ${REPO}/pulls/1/merge`]: () => Response.json({ merged: true }),
      [`PUT ${REPO}/pulls/2/merge`]: () => Response.json({ merged: true }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/merge-stack", {
      ...ref,
      number: 2,
      method: "squash",
      heads: heads(1, 2),
    });
    expect(((await res.json()) as StackMergeView).steps).toEqual([
      { number: 1, outcome: "done" },
      { number: 2, outcome: "done" },
    ]);
    expect(sent).toEqual([
      {
        method: "PUT",
        url: `${REPO}/pulls/1/merge`,
        body: { merge_method: "squash", sha: sha(1) },
      },
      { method: "PATCH", url: `${REPO}/pulls/2`, body: { base: "main" } },
      {
        method: "PUT",
        url: `${REPO}/pulls/2/merge`,
        body: { merge_method: "squash", sha: sha(2) },
      },
    ]);
  });

  it("stops at the first merge the platform refuses, the ones below left merged", async () => {
    const sent = platform({
      ...githubOpen(),
      [`PATCH ${REPO}/pulls/2`]: () => Response.json({}),
      [`PUT ${REPO}/pulls/1/merge`]: () => Response.json({ merged: true }),
      [`PUT ${REPO}/pulls/2/merge`]: () => new Response("{}", { status: 405 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/merge-stack", {
      ...ref,
      number: 3,
      method: "merge",
      heads: heads(1, 2, 3),
    });
    expect(((await res.json()) as StackMergeView).steps).toEqual([
      { number: 1, outcome: "done" },
      { number: 2, outcome: "not_mergeable" },
    ]);
    expect(sent.map((s) => `${s.method} ${s.url}`)).not.toContain(`PUT ${REPO}/pulls/3/merge`);
  });

  it("merges nothing when the stack is not the one the page read", async () => {
    const sent = platform(githubOpen());
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/merge-stack", {
      ...ref,
      number: 3,
      method: "merge",
      heads: heads(2, 3),
    });
    expect(((await res.json()) as StackMergeView).steps).toEqual([
      { number: 3, outcome: "head_moved" },
    ]);
    expect(sent).toEqual([]);
  });

  it("passes the head the page read, so a moved pull request is not merged", async () => {
    platform({
      ...githubOpen(),
      [`PUT ${REPO}/pulls/1/merge`]: () => new Response("{}", { status: 409 }),
    });
    const a = await signInWithGithub();
    const res = await post(a.send, "/api/pulls/merge-stack", {
      ...ref,
      number: 1,
      method: "merge",
      heads: heads(1),
    });
    expect(((await res.json()) as StackMergeView).steps).toEqual([
      { number: 1, outcome: "head_moved" },
    ]);
  });
});

describe("a GitLab merge request's stack", () => {
  const mr = (iid: number, source: string, target: string, project = 9) => ({
    iid,
    title: `Step ${iid}`,
    web_url: `${GITLAB}/Group/Sub/Project/-/merge_requests/${iid}`,
    draft: iid === 2,
    source_branch: source,
    target_branch: target,
    sha: sha(iid),
    source_project_id: project,
    target_project_id: 9,
  });
  const open = {
    [`GET ${PROJECT}/merge_requests`]: () =>
      Response.json([mr(1, "a", "main"), mr(2, "b", "a"), mr(3, "a", "main", 10)]),
  };
  const lab = { platform: "gitlab", repo: "Group/Sub/Project" };

  it("lists the stack from the source and target branches", async () => {
    platform(open);
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const res = await a.send(
      `/api/pulls/stack?platform=gitlab&repo=${encodeURIComponent("Group/Sub/Project")}&number=1`,
    );
    const view = (await res.json()) as PullStackView;
    expect(view.pulls.map((p) => [p.number, p.parent, p.draft])).toEqual([
      [1, null, false],
      [2, 1, true],
    ]);
  });

  it("retargets and merges, and stops when a retarget is refused", async () => {
    const sent = platform({
      ...open,
      [`PUT ${PROJECT}/merge_requests/1/merge`]: () => Response.json({ state: "merged" }),
      [`PUT ${PROJECT}/merge_requests/2`]: () => new Response("{}", { status: 403 }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const res = await post(a.send, "/api/pulls/merge-stack", {
      ...lab,
      number: 2,
      method: "squash",
      heads: heads(1, 2),
    });
    expect(((await res.json()) as StackMergeView).steps).toEqual([
      { number: 1, outcome: "done" },
      { number: 2, outcome: "refused" },
    ]);
    expect(sent).toEqual([
      {
        method: "PUT",
        url: `${PROJECT}/merge_requests/1/merge`,
        body: { sha: sha(1), squash: true },
      },
      { method: "PUT", url: `${PROJECT}/merge_requests/2`, body: { target_branch: "main" } },
    ]);
  });
});

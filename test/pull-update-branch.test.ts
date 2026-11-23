import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditPage } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request behind its base is brought up to date from its page, as
// the signed-in user: GitHub merges the base in, GitLab rebases, and
// neither is asked to when the head the user saw has moved.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const REPO = "https://api.github.com/repos/octo/api";
const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/3`;
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const hub = { platform: "github", repo: "octo/api", number: 7, head: HEAD };
const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3, head: HEAD };

type Sent = { method: string; url: string; body: Record<string, unknown> };

function platform(routes: Record<string, () => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const text = req.method === "GET" ? "" : await req.text();
      if (req.method !== "GET") {
        sent.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : {} });
      }
      return route();
    },
  });
  return sent;
}

const update = (a: Awaited<ReturnType<typeof signInWithGithub>>, body: unknown) =>
  a.send("/api/pulls/update-branch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const githubPull =
  (over: Record<string, unknown> = {}) =>
  () =>
    Response.json({
      node_id: "PR_7",
      state: "open",
      merged_at: null,
      head: { sha: HEAD },
      ...over,
    });

const refusal =
  (status: number, message: string, headers: Record<string, string> = {}) =>
  () =>
    Response.json({ message }, { status, headers });

const branchAudit = async (a: Awaited<ReturnType<typeof signInWithGithub>>) => {
  const log = (await (await a.send("/api/audit")).json()) as AuditPage;
  return log.events.filter((e) => e.kind === "pull.branch_updated").map((e) => e.detail);
};

describe("updating a GitHub pull request's branch", () => {
  it("merges the base in, guarded by the head the user saw, and audits it", async () => {
    const sent = platform({
      [`GET ${REPO}/pulls/7`]: githubPull(),
      [`PUT ${REPO}/pulls/7/update-branch`]: () =>
        Response.json({ message: "Updating pull request branch." }, { status: 202 }),
    });
    const a = await signInWithGithub();
    // The head is compared after it is normalised, as GitHub writes it.
    const res = await update(a, { ...hub, head: ` ${HEAD.toUpperCase()} ` });
    expect(await answer(res)).toEqual({ status: 200, body: { outcome: "updating" } });
    expect(sent).toEqual([
      {
        method: "PUT",
        url: `${REPO}/pulls/7/update-branch`,
        body: { expected_head_sha: HEAD },
      },
    ]);
    expect(await branchAudit(a)).toEqual([{ pull: "octo/api#7", head: HEAD }]);
  });

  it("refuses a head that moved as stale, unsent, and when GitHub says it moved", async () => {
    let head = MOVED;
    const sent = platform({
      [`GET ${REPO}/pulls/7`]: () => githubPull({ head: { sha: head } })(),
      [`PUT ${REPO}/pulls/7/update-branch`]: refusal(
        422,
        "expected head sha didn't match current head ref.",
      ),
    });
    const a = await signInWithGithub();
    expect(await answer(await update(a, hub))).toEqual({ status: 409, body: { error: "stale" } });
    expect(sent).toEqual([]);
    head = HEAD;
    expect(await answer(await update(a, hub))).toEqual({ status: 409, body: { error: "stale" } });
    expect(sent).toHaveLength(1);
    expect(await branchAudit(a)).toEqual([]);
  });

  it("names GitHub's refusals: up to date, conflicts and no permission", async () => {
    let refused = refusal(422, "There are no new commits on the base branch.");
    platform({
      [`GET ${REPO}/pulls/7`]: githubPull(),
      [`PUT ${REPO}/pulls/7/update-branch`]: () => refused(),
    });
    const a = await signInWithGithub();
    const outcome = async () =>
      ((await (await update(a, hub)).json()) as { outcome: string }).outcome;
    expect(await outcome()).toBe("up_to_date");
    refused = refusal(422, "merge conflict between base and head");
    expect(await outcome()).toBe("conflicts");
    refused = refusal(403, "Resource not accessible by integration");
    expect(await outcome()).toBe("forbidden");
    expect(await branchAudit(a)).toEqual([]);
  });

  it("sends nothing for a closed pull request", async () => {
    const sent = platform({
      [`GET ${REPO}/pulls/7`]: githubPull({ state: "closed", merged_at: "2026-11-20T10:00:00Z" }),
    });
    const a = await signInWithGithub();
    expect(await (await update(a, hub)).json()).toEqual({ outcome: "not_open" });
    expect(sent).toEqual([]);
  });

  it("answers a used-up allowance with when it is back, not as no permission", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: githubPull(),
      [`PUT ${REPO}/pulls/7/update-branch`]: refusal(403, "API rate limit exceeded", {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1795000000",
      }),
    });
    const a = await signInWithGithub();
    expect(await answer(await update(a, hub))).toEqual({
      status: 502,
      body: {
        error: "upstream_unreachable",
        reason: "platform_rate_limited",
        retryAt: new Date(1_795_000_000_000).toISOString(),
      },
    });
  });

  it("refuses unsent a head that is not a commit id, or a bad repository", async () => {
    const sent = platform({});
    const a = await signInWithGithub();
    for (const body of [
      { ...hub, head: "main" },
      { ...hub, head: `${HEAD}0` },
      { ...hub, repo: "../octo" },
    ]) {
      expect((await update(a, body)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("updating a GitLab merge request's branch", () => {
  const diverged = `GET ${MR}?include_diverged_commits_count=true`;
  const mr =
    (over: Record<string, unknown> = {}) =>
    () =>
      Response.json({
        state: "opened",
        sha: HEAD,
        has_conflicts: false,
        diverged_commits_count: 2,
        rebase_in_progress: false,
        ...over,
      });

  it("rebases it on the target and audits it", async () => {
    const sent = platform({
      [diverged]: mr(),
      [`PUT ${MR}/rebase`]: () => Response.json({ rebase_in_progress: true }, { status: 202 }),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    expect(await answer(await update(a, lab))).toEqual({
      status: 200,
      body: { outcome: "updating" },
    });
    expect(sent.map((s) => [s.method, s.url])).toEqual([["PUT", `${MR}/rebase`]]);
    expect(await branchAudit(a)).toEqual([{ pull: "Group/Sub/Project#3", head: HEAD }]);
  });

  it("sends nothing for a moved head, one up to date, one with conflicts or one merged", async () => {
    let over: Record<string, unknown> = { sha: MOVED };
    const sent = platform({ [diverged]: () => mr(over)() });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    expect(await answer(await update(a, lab))).toEqual({ status: 409, body: { error: "stale" } });
    const outcome = async () =>
      ((await (await update(a, lab)).json()) as { outcome: string }).outcome;
    over = { diverged_commits_count: 0 };
    expect(await outcome()).toBe("up_to_date");
    over = { has_conflicts: true };
    expect(await outcome()).toBe("conflicts");
    over = { rebase_in_progress: true };
    expect(await outcome()).toBe("updating");
    over = { state: "merged" };
    expect(await outcome()).toBe("not_open");
    expect(sent).toEqual([]);
  });

  it("answers GitLab's refusal to rebase as no permission", async () => {
    platform({
      [diverged]: mr(),
      [`PUT ${MR}/rebase`]: refusal(403, "403 Forbidden"),
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    expect(await (await update(a, lab)).json()).toEqual({ outcome: "forbidden" });
    expect(await branchAudit(a)).toEqual([]);
  });
});

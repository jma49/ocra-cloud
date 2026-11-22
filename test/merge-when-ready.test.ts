import { afterEach, describe, expect, it, vi } from "vitest";
import { githubSignal, gitlabSignal } from "../src/merge-when-ready/hooks.js";
import { gitlabAutoMerge } from "../src/platforms/gitlab-auto-merge.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// Merge when ready, as far as the Worker goes: GitLab's merge when the
// pipeline succeeds, what the webhooks say to an armed intent, and no
// server fallback on a host that moves no intents.

afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const ORIGIN = "https://gitlab.example.com";
const MR = `${ORIGIN}/api/v4/projects/${encodeURIComponent("group/api")}/merge_requests/3`;

function gitlab(mr: Record<string, unknown>, merge: () => Response) {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.method === "GET" && req.url === MR) return Response.json(mr);
    sent.push({ url: req.url, body: await req.json() });
    return merge();
  });
  return sent;
}

describe("GitLab's merge when the pipeline succeeds", () => {
  const open = { state: "opened", sha: HEAD, detailed_merge_status: "ci_still_running" };

  it("arms the head the user saw, with the method", async () => {
    const sent = gitlab(open, () => Response.json({}));
    const merge = { method: "squash" as const, head: HEAD };
    expect(await gitlabAutoMerge(ORIGIN).enable("t", "group/api", 3, merge)).toBe("done");
    expect(sent).toEqual([
      {
        url: `${MR}/merge`,
        body: { sha: HEAD, squash: true, auto_merge: true, merge_when_pipeline_succeeds: true },
      },
    ]);
    const moved = { method: "merge" as const, head: "b".repeat(40) };
    expect(await gitlabAutoMerge(ORIGIN).enable("t", "group/api", 3, moved)).toBe("head_moved");
  });

  it("answers what it will not arm as unavailable, and what is mergeable as ready", async () => {
    gitlab(open, () => new Response(null, { status: 405 }));
    const merge = { method: "merge" as const, head: HEAD };
    expect(await gitlabAutoMerge(ORIGIN).enable("t", "group/api", 3, merge)).toBe("unavailable");
    vi.restoreAllMocks();
    const sent = gitlab({ ...open, detailed_merge_status: "mergeable" }, () => Response.json({}));
    expect(await gitlabAutoMerge(ORIGIN).enable("t", "group/api", 3, merge)).toBe("ready");
    expect(sent).toEqual([]);
  });

  it("cancels only what is armed", async () => {
    const sent = gitlab({ ...open, merge_when_pipeline_succeeds: true }, () => Response.json({}));
    expect(await gitlabAutoMerge(ORIGIN).disable("t", "group/api", 3)).toBe("done");
    expect(sent.map((s) => s.url)).toEqual([`${MR}/cancel_merge_when_pipeline_succeeds`]);
  });
});

describe("what the webhooks say to an armed intent", () => {
  const repository = { id: 11, full_name: "Octo/API" };

  it("reads GitHub's pushes, closes, reviews, checks and statuses", () => {
    const pull = (action: string, merged?: boolean) => ({
      action,
      number: 7,
      pull_request: { head: { sha: HEAD }, merged },
      repository,
    });
    const of = (signal: unknown) => ({ repoId: "11", fullName: "Octo/API", signal });
    expect(githubSignal("pull_request", pull("synchronize"))).toEqual(
      of({ number: 7, newHead: HEAD }),
    );
    expect(githubSignal("pull_request", pull("closed", true))).toEqual(
      of({ number: 7, closed: "merged" }),
    );
    expect(githubSignal("pull_request", pull("closed", false))).toEqual(
      of({ number: 7, closed: "closed" }),
    );
    expect(
      githubSignal("pull_request_review", { pull_request: { number: 7 }, repository }),
    ).toEqual(of({ number: 7 }));
    expect(
      githubSignal("check_run", { action: "completed", check_run: { head_sha: HEAD }, repository }),
    ).toEqual(of({ head: HEAD }));
    expect(githubSignal("status", { sha: HEAD, state: "success", repository })).toEqual(
      of({ head: HEAD }),
    );
    // A check still running, a pending status and a push say nothing here.
    expect(
      githubSignal("check_run", { action: "created", check_run: { head_sha: HEAD }, repository }),
    ).toBeNull();
    expect(githubSignal("status", { sha: HEAD, state: "pending", repository })).toBeNull();
    expect(githubSignal("push", { repository })).toBeNull();
  });

  it("reads GitLab's merge request and pipeline hooks", () => {
    const project = { path_with_namespace: "group/api" };
    const mr = (attributes: Record<string, unknown>) => ({
      object_attributes: { iid: 3, last_commit: { id: HEAD }, ...attributes },
      project,
    });
    expect(gitlabSignal("Merge Request Hook", mr({ action: "update", oldrev: "x" }))).toEqual({
      fullName: "group/api",
      signal: { number: 3, newHead: HEAD },
    });
    expect(gitlabSignal("Merge Request Hook", mr({ action: "approved" }))?.signal).toEqual({
      number: 3,
    });
    expect(gitlabSignal("Merge Request Hook", mr({ action: "merge" }))?.signal).toEqual({
      number: 3,
      closed: "merged",
    });
    const pipeline = { object_attributes: { sha: HEAD, status: "success" }, project };
    expect(gitlabSignal("Pipeline Hook", pipeline)?.signal).toEqual({ head: HEAD });
    const running = { object_attributes: { sha: HEAD, status: "running" }, project };
    expect(gitlabSignal("Pipeline Hook", running)).toBeNull();
  });
});

describe("on a host that moves no intents", () => {
  it("arms nothing where the repository has auto-merge off", async () => {
    await resetDb();
    githubFake({
      extra: (req) =>
        req.url === "https://api.github.com/graphql"
          ? Response.json({
              data: {
                repository: {
                  autoMergeAllowed: false,
                  pullRequest: {
                    id: "PR_7",
                    headRefOid: HEAD,
                    state: "OPEN",
                    mergeStateStatus: "BLOCKED",
                    autoMergeRequest: null,
                  },
                },
              },
            })
          : undefined,
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/merge-when-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "github",
        repo: "octo/api",
        number: 7,
        method: "squash",
        head: HEAD,
      }),
    });
    expect(await res.json()).toEqual({ outcome: "unavailable", intent: null });
    const read = await a.send("/api/pulls/merge-when-ready?platform=github&repo=octo/api&number=7");
    expect(await read.json()).toEqual({ intent: null, server: false });
  });
});

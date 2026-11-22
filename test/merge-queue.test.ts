import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's place in the platform's own merge queue: read, joined and
// left as the signed-in user, with the head they saw.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const GRAPHQL = "https://api.github.com/graphql";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;

type Sent = { url: string; body: unknown };

function fake(answer: (url: string, body: unknown) => Response | undefined) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const body = req.method === "GET" ? null : await req.json();
      const res = answer(req.url, body);
      if (res && req.method !== "GET") sent.push({ url: req.url, body });
      return res;
    },
  });
  return sent;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const pullNode = (entry: unknown, queue = true) =>
  Response.json({
    data: {
      repository: {
        pullRequest: {
          id: "PR_1",
          headRefOid: HEAD,
          mergeQueue: queue ? { id: "MQ_1" } : null,
          mergeQueueEntry: entry,
        },
      },
    },
  });

const isQuery = (body: unknown) => String((body as { query: string }).query).startsWith("query");

describe("GitHub's merge queue", () => {
  const ref = { platform: "github", repo: "octo/api", number: 7 };
  const status = "/api/pulls/queue?platform=github&repo=octo/api&number=7";

  it("shows where the pull request stands, and whether the branch has a queue", async () => {
    const answers = [pullNode({ state: "AWAITING_CHECKS", position: 2 }), pullNode(null, false)];
    fake((url, body) => (url === GRAPHQL && isQuery(body) ? answers.shift() : undefined));
    const a = await signInWithGithub();
    expect(await (await a.send(status)).json()).toEqual({
      enabled: true,
      entry: { state: "checking", position: 2 },
    });
    expect(await (await a.send(status)).json()).toEqual({ enabled: false, entry: null });
  });

  it("queues the head the user saw, and only that head", async () => {
    const sent = fake((url, body) => {
      if (url !== GRAPHQL) return undefined;
      return isQuery(body)
        ? pullNode(null)
        : Response.json({ data: { enqueuePullRequest: { clientMutationId: null } } });
    });
    const a = await signInWithGithub();
    const moved = await a.send("/api/pulls/enqueue", json({ ...ref, head: MOVED }));
    expect(await moved.json()).toEqual({ outcome: "head_moved" });
    const queued = await a.send("/api/pulls/enqueue", json({ ...ref, head: HEAD }));
    expect(await queued.json()).toEqual({ outcome: "done" });
    const mutations = sent.filter((s) => !isQuery(s.body));
    expect(mutations.map((s) => (s.body as { variables: unknown }).variables)).toEqual([
      { id: "PR_1", head: HEAD },
    ]);
  });

  it("answers GraphQL's refusals as refused or not mergeable", async () => {
    const errors = [[{ type: "FORBIDDEN" }], [{ type: "UNPROCESSABLE" }]];
    fake((url, body) => {
      if (url !== GRAPHQL) return undefined;
      return isQuery(body) ? pullNode(null) : Response.json({ data: null, errors: errors.shift() });
    });
    const a = await signInWithGithub();
    const outcomes = [];
    for (let i = 0; i < 2; i++) {
      const res = await a.send("/api/pulls/enqueue", json({ ...ref, head: HEAD }));
      outcomes.push(((await res.json()) as { outcome: string }).outcome);
    }
    expect(outcomes).toEqual(["refused", "not_mergeable"]);
  });

  it("refuses to queue on a branch without a queue, and leaves one it is not in", async () => {
    const answers = [pullNode(null, false), pullNode(null)];
    const sent = fake((url, body) =>
      url === GRAPHQL && isQuery(body) ? answers.shift() : undefined,
    );
    const a = await signInWithGithub();
    const queued = await a.send("/api/pulls/enqueue", json({ ...ref, head: HEAD }));
    expect(await queued.json()).toEqual({ outcome: "refused" });
    const left = await a.send("/api/pulls/dequeue", json(ref));
    expect(await left.json()).toEqual({ outcome: "done" });
    expect(sent.filter((s) => !isQuery(s.body))).toEqual([]);
  });

  it("takes a queued pull request out", async () => {
    const sent = fake((url, body) => {
      if (url !== GRAPHQL) return undefined;
      return isQuery(body)
        ? pullNode({ state: "QUEUED", position: 1 })
        : Response.json({ data: { dequeuePullRequest: { clientMutationId: null } } });
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/dequeue", json(ref));
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.filter((s) => !isQuery(s.body)).map((s) => s.body)).toMatchObject([
      { variables: { id: "PR_1" } },
    ]);
  });
});

describe("GitLab's merge trains", () => {
  const ref = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 };
  const status = `/api/pulls/queue?platform=gitlab&repo=${encodeURIComponent(ref.repo)}&number=3`;
  const car = (iid: number, status: string) => ({
    status,
    target_branch: "main",
    merge_request: { iid },
  });

  it("finds the merge request's car and its place in the train", async () => {
    fake((url) => {
      if (url === PROJECT) return Response.json({ merge_trains_enabled: true });
      if (url === `${PROJECT}/merge_trains/merge_requests/3`) return Response.json(car(3, "fresh"));
      if (url.startsWith(`${PROJECT}/merge_trains?`)) {
        expect(new URL(url).searchParams.get("target_branch")).toBe("main");
        return Response.json([car(9, "fresh"), car(3, "fresh")]);
      }
      return undefined;
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    expect(await (await a.send(status)).json()).toEqual({
      enabled: true,
      entry: { state: "checking", position: 2 },
    });
  });

  it("says a project without merge trains has no queue, and one not in it has no car", async () => {
    const settings = [{}, { merge_trains_enabled: true }];
    fake((url) => {
      if (url === PROJECT) return Response.json(settings.shift());
      if (url === `${PROJECT}/merge_trains/merge_requests/3`) {
        return new Response("{}", { status: 404 });
      }
      return undefined;
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    expect(await (await a.send(status)).json()).toEqual({ enabled: false, entry: null });
    expect(await (await a.send(status)).json()).toEqual({ enabled: true, entry: null });
  });

  it("adds the head the user saw to the train, and takes it off again", async () => {
    const answers = [new Response("{}", { status: 201 }), new Response("{}", { status: 409 })];
    const sent = fake((url) => {
      if (url === `${PROJECT}/merge_trains/merge_requests/3`) return answers.shift();
      if (url === `${PROJECT}/merge_requests/3/cancel_merge_when_pipeline_succeeds`) {
        return new Response("{}", { status: 201 });
      }
      return undefined;
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const added = await a.send("/api/pulls/enqueue", json({ ...ref, head: HEAD }));
    const moved = await a.send("/api/pulls/enqueue", json({ ...ref, head: MOVED }));
    const left = await a.send("/api/pulls/dequeue", json(ref));
    expect([await added.json(), await moved.json(), await left.json()]).toEqual([
      { outcome: "done" },
      { outcome: "head_moved" },
      { outcome: "done" },
    ]);
    expect(sent.map((s) => s.body)).toEqual([{ sha: HEAD }, { sha: MOVED }, {}]);
  });
});

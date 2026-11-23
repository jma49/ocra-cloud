import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditPage, PullCandidatesView, PullPeopleView } from "../src/shared/index.js";
import { call, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's reviewers, how each answered, and its assignees, read
// as the signed-in user; the repository's people to ask, by login prefix;
// and asking, unasking, assigning and unassigning them as the user, each
// change in the account's audit log.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const REPO = "https://api.github.com/repos/octo/api";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}`;
const MR = `${PROJECT}/merge_requests/3`;
const hub = { platform: "github", repo: "octo/api", number: 7 } as const;
const lab = { platform: "gitlab", repo: "Group/Sub/Project", number: 3 } as const;
const query = (r: { platform: string; repo: string; number: number }) =>
  `platform=${r.platform}&repo=${r.repo}&number=${r.number}`;

type Sent = { method: string; url: string; body: Record<string, unknown> };
type Route = (body: Sent["body"], req: Request) => Response;

function platform(routes: Record<string, Route>) {
  const sent: Sent[] = [];
  const asked: string[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const text = req.method === "GET" ? "" : await req.text();
      const body = (text ? JSON.parse(text) : {}) as Sent["body"];
      if (req.method === "GET") asked.push(req.url);
      else sent.push({ method: req.method, url: req.url, body });
      return route(body, req);
    },
  });
  return { sent, asked };
}

type Session = Awaited<ReturnType<typeof signInWithGithub>>;
const post = (a: Session, path: string, body: unknown) =>
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

const audited = async (a: Session) =>
  ((await (await a.send("/api/audit")).json()) as AuditPage).events.filter((e) =>
    e.kind.startsWith("pull."),
  );

const githubPull = (over: Record<string, unknown> = {}) =>
  Response.json({
    user: { login: "author", type: "User" },
    requested_reviewers: [{ login: "lead", type: "User" }],
    requested_teams: [{ slug: "core", name: "Core" }],
    assignees: [{ login: "author" }],
    ...over,
  });

describe("reading a pull request's people", () => {
  it("lists GitHub's asked users and teams, each reviewer's latest verdict, and the assignees", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => githubPull(),
      [`GET ${REPO}/pulls/7/reviews?per_page=100`]: () =>
        Response.json([
          { user: { login: "dba" }, state: "APPROVED" },
          { user: { login: "dba" }, state: "COMMENTED" },
          { user: { login: "lead" }, state: "CHANGES_REQUESTED" },
          { user: { login: "ana" }, state: "COMMENTED" },
          { user: { login: "ana" }, state: "CHANGES_REQUESTED" },
          { user: { login: "author" }, state: "COMMENTED" },
          { user: { login: "ci[bot]", type: "Bot" }, state: "APPROVED" },
          { user: { login: "me" }, state: "PENDING" },
        ]),
    });
    const a = await signInWithGithub();
    const view = (await (await a.send(`/api/pulls/people?${query(hub)}`)).json()) as PullPeopleView;
    expect(view).toEqual({
      ...hub,
      author: "author",
      reviewers: [
        { login: "lead", state: "requested" },
        { login: "dba", state: "approved" },
        { login: "ana", state: "changes_requested" },
      ],
      teams: [{ slug: "core", name: "Core" }],
      assignees: ["author"],
      truncated: false,
    } satisfies PullPeopleView);
  });

  it("reads GitLab's reviewers with their state, and its assignees", async () => {
    platform({
      [`GET ${MR}`]: () =>
        Response.json({
          author: { id: 1, username: "author" },
          assignees: [{ id: 2, username: "ops" }],
        }),
      [`GET ${MR}/reviewers?per_page=100`]: () =>
        Response.json([
          { user: { id: 3, username: "lead" }, state: "unreviewed" },
          { user: { id: 4, username: "dba" }, state: "approved" },
          { user: { id: 5, username: "ana" }, state: "requested_changes" },
          { user: { id: 6, username: "project_9_bot_x", bot: true }, state: "reviewed" },
        ]),
    });
    const a = await onGitlab();
    const view = (await (await a.send(`/api/pulls/people?${query(lab)}`)).json()) as PullPeopleView;
    expect(view).toMatchObject({
      author: "author",
      reviewers: [
        { login: "lead", state: "requested" },
        { login: "dba", state: "approved" },
        { login: "ana", state: "changes_requested" },
      ],
      teams: [],
      assignees: ["ops"],
    });
  });

  it("answers 404 for a pull request the user's token cannot see, and for a path that is no repository", async () => {
    platform({
      [`GET ${REPO}/pulls/7`]: () => new Response("{}", { status: 404 }),
      [`GET ${REPO}/pulls/7/reviews?per_page=100`]: () => new Response("{}", { status: 404 }),
    });
    const a = await signInWithGithub();
    expect((await a.send(`/api/pulls/people?${query(hub)}`)).status).toBe(404);
    const bad = await a.send("/api/pulls/people?platform=github&repo=../x&number=7");
    expect(bad.status).toBe(404);
  });

  it("reads nothing for another account, and never shows it this account's changes", async () => {
    const { asked } = platform({
      [`GET ${REPO}/pulls/7`]: () => githubPull(),
      [`POST ${REPO}/issues/7/assignees`]: () => githubPull({ assignees: [{ login: "ops" }] }),
    });
    const a = await signInWithGithub();
    expect((await post(a, "/api/pulls/people/assignees", { ...hub, add: ["ops"] })).status).toBe(
      200,
    );
    const other = await signIn(9, "eve");
    const theirs = await call(`/api/pulls/people?${query(hub)}`, { auth: other.auth });
    expect(theirs.status).not.toBe(200);
    expect(asked).toEqual([]);
    const log = (await (await call("/api/audit", { auth: other.auth })).json()) as AuditPage;
    expect(log.events.filter((e) => e.kind.startsWith("pull."))).toEqual([]);
  });
});

describe("searching the repository's people", () => {
  it("filters GitHub's assignable people by login prefix, without case, and leaves bots out", async () => {
    const page = [
      { login: "Dana", type: "User" },
      { login: "dan", type: "User" },
      { login: "danbot[bot]", type: "Bot" },
      { login: "ada", type: "User" },
    ];
    const { asked } = platform({
      [`GET ${REPO}/assignees?per_page=100&page=1`]: () => Response.json(page),
    });
    const a = await signInWithGithub();
    const search = async (prefix: string) =>
      (await (
        await a.send(`/api/pulls/people/candidates?platform=github&repo=octo/api&prefix=${prefix}`)
      ).json()) as PullCandidatesView;
    expect(await search("DAN")).toEqual({
      candidates: [
        { login: "dan", name: null },
        { login: "Dana", name: null },
      ],
      truncated: false,
    });
    expect((await search("%40ad")).candidates.map((c) => c.login)).toEqual(["ada"]);
    expect(asked).toHaveLength(2);
  });

  it("reads at most five pages of GitHub's people and says when there may be more", async () => {
    const { asked } = platform(
      Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((p) => [
          `GET ${REPO}/assignees?per_page=100&page=${p}`,
          () => Response.json(Array.from({ length: 100 }, (_, i) => ({ login: `u${p}-${i}` }))),
        ]),
      ),
    );
    const a = await signInWithGithub();
    const res = await a.send(
      "/api/pulls/people/candidates?platform=github&repo=octo/api&prefix=zz",
    );
    expect(await res.json()).toEqual({ candidates: [], truncated: true });
    expect(asked).toHaveLength(5);
  });

  it("answers at most twenty", async () => {
    platform({
      [`GET ${REPO}/assignees?per_page=100&page=1`]: () =>
        Response.json(Array.from({ length: 30 }, (_, i) => ({ login: `u${i}` }))),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/people/candidates?platform=github&repo=octo/api&prefix=u");
    const view = (await res.json()) as PullCandidatesView;
    expect(view.candidates).toHaveLength(20);
    expect(view.truncated).toBe(true);
  });

  it("searches GitLab's project members, keeping only active ones whose username starts so", async () => {
    const { asked } = platform({
      [`GET ${PROJECT}/members/all?per_page=100&query=da`]: () =>
        Response.json([
          { id: 1, username: "dana", name: "Dana Scully", state: "active" },
          { id: 1, username: "dana", name: "Dana Scully", state: "active" },
          { id: 2, username: "ada", name: "Ada Davis", state: "active" },
          { id: 3, username: "dave", name: "Dave", state: "blocked" },
        ]),
    });
    const a = await onGitlab();
    const res = await a.send(
      `/api/pulls/people/candidates?platform=gitlab&repo=${encodeURIComponent(lab.repo)}&prefix=da`,
    );
    expect(await res.json()).toEqual({
      candidates: [{ login: "dana", name: "Dana Scully" }],
      truncated: false,
    });
    expect(asked).toHaveLength(1);
  });

  it("refuses a prefix that no login could start with", async () => {
    const { asked } = platform({});
    const a = await signInWithGithub();
    const res = await a.send(
      "/api/pulls/people/candidates?platform=github&repo=octo/api&prefix=a%20b",
    );
    expect(res.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("answers 404 where the user's token cannot list the repository's people", async () => {
    platform({
      [`GET ${REPO}/assignees?per_page=100&page=1`]: () => new Response("{}", { status: 404 }),
    });
    const a = await signInWithGithub();
    const res = await a.send("/api/pulls/people/candidates?platform=github&repo=octo/api&prefix=a");
    expect(res.status).toBe(404);
  });
});

describe("changing reviewers", () => {
  it("asks and unasks on GitHub, removing only those asked now, and audits it", async () => {
    const { sent } = platform({
      [`GET ${REPO}/pulls/7`]: () => githubPull(),
      [`POST ${REPO}/pulls/7/requested_reviewers`]: () => Response.json({}, { status: 201 }),
      [`DELETE ${REPO}/pulls/7/requested_reviewers`]: () => Response.json({}),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/people/reviewers", {
      ...hub,
      add: [" @dba "],
      remove: ["LEAD", "gone"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => [s.method, s.body])).toEqual([
      ["POST", { reviewers: ["dba"] }],
      ["DELETE", { reviewers: ["lead"] }],
    ]);
    expect(await audited(a)).toMatchObject([
      {
        kind: "pull.reviewers_changed",
        detail: { pull: "octo/api#7", added: ["dba"], removed: ["LEAD", "gone"] },
      },
    ]);
  });

  it("answers GitHub's refusal as one, removes nothing after it, and audits nothing", async () => {
    const { sent } = platform({
      [`POST ${REPO}/pulls/7/requested_reviewers`]: () => new Response("{}", { status: 422 }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/people/reviewers", {
      ...hub,
      add: ["x"],
      remove: ["lead"],
    });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(sent.map((s) => s.method)).toEqual(["POST"]);
    expect(await audited(a)).toEqual([]);
  });

  it("sets GitLab's reviewer ids at once, keeping those not removed", async () => {
    const { sent } = platform({
      [`GET ${MR}`]: () =>
        Response.json({
          reviewers: [
            { id: 3, username: "lead" },
            { id: 4, username: "dba" },
          ],
        }),
      [`GET ${GITLAB}/api/v4/users?username=ana`]: () => Response.json([{ id: 5 }]),
      [`PUT ${MR}`]: () => Response.json({}),
    });
    const a = await onGitlab();
    const res = await post(a, "/api/pulls/people/reviewers", {
      ...lab,
      add: ["ana"],
      remove: ["Lead"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => s.body)).toEqual([{ reviewer_ids: [4, 5] }]);
  });

  it("refuses unsent a GitLab login that is no user", async () => {
    const { sent } = platform({
      [`GET ${MR}`]: () => Response.json({ reviewers: [] }),
      [`GET ${GITLAB}/api/v4/users?username=ghost`]: () => Response.json([]),
    });
    const a = await onGitlab();
    const res = await post(a, "/api/pulls/people/reviewers", { ...lab, add: ["ghost"] });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(sent).toEqual([]);
  });

  it("audits the reviewers the suggestions card asks for", async () => {
    platform({
      [`POST ${REPO}/pulls/7/requested_reviewers`]: () => Response.json({}, { status: 201 }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/reviewers", { ...hub, logins: ["dba"] });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(await audited(a)).toMatchObject([
      { kind: "pull.reviewers_changed", detail: { added: ["dba"], removed: [] } },
    ]);
  });
});

describe("changing assignees", () => {
  it("assigns and unassigns on GitHub through the issue's assignees", async () => {
    const { sent } = platform({
      [`POST ${REPO}/issues/7/assignees`]: () =>
        githubPull({ assignees: [{ login: "author" }, { login: "Ops" }] }),
      [`DELETE ${REPO}/issues/7/assignees`]: () => githubPull({ assignees: [{ login: "Ops" }] }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/people/assignees", {
      ...hub,
      add: ["ops"],
      remove: ["author"],
    });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => [s.method, s.body])).toEqual([
      ["POST", { assignees: ["ops"] }],
      ["DELETE", { assignees: ["author"] }],
    ]);
    expect(await audited(a)).toMatchObject([
      { kind: "pull.assignees_changed", detail: { added: ["ops"], removed: ["author"] } },
    ]);
  });

  it("answers refused when GitHub leaves out someone it cannot assign", async () => {
    platform({
      [`POST ${REPO}/issues/7/assignees`]: () => githubPull({ assignees: [] }),
    });
    const a = await signInWithGithub();
    const res = await post(a, "/api/pulls/people/assignees", { ...hub, add: ["outsider"] });
    expect(await res.json()).toEqual({ outcome: "refused" });
    expect(await audited(a)).toEqual([]);
  });

  it("sets GitLab's assignee ids at once", async () => {
    const { sent } = platform({
      [`GET ${MR}`]: () => Response.json({ assignees: [{ id: 2, username: "ops" }] }),
      [`PUT ${MR}`]: () => Response.json({}),
    });
    const a = await onGitlab();
    const res = await post(a, "/api/pulls/people/assignees", { ...lab, remove: ["ops"] });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent.map((s) => s.body)).toEqual([{ assignee_ids: [] }]);
  });

  it("answers upstream_unreachable when GitLab cannot be read", async () => {
    platform({ [`GET ${MR}`]: () => new Response("{}", { status: 500 }) });
    const a = await onGitlab();
    const res = await post(a, "/api/pulls/people/assignees", { ...lab, remove: ["ops"] });
    expect(res.status).toBe(502);
  });
});

describe("what an edit may hold", () => {
  it("refuses unsent nothing to change, a login twice, a login that is none, or too many", async () => {
    const { sent } = platform({});
    const a = await signInWithGithub();
    const many = Array.from({ length: 11 }, (_, i) => `u${i}`);
    for (const edit of [
      { add: [], remove: [] },
      { add: ["dba"], remove: ["@DBA"] },
      { add: ["a b"] },
      { add: ["../x"] },
      { add: many },
    ]) {
      for (const path of ["/api/pulls/people/reviewers", "/api/pulls/people/assignees"]) {
        expect((await post(a, path, { ...hub, ...edit })).status).toBe(400);
      }
    }
    expect(sent).toEqual([]);
  });
});

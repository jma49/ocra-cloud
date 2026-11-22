import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { PullReviewersView } from "../src/shared/index.js";
import { db, resetDb, signIn } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// Reviewers suggested on a pull request's page: CODEOWNERS at the base, the
// enrolled repository's recent reviewers of this account only, and each
// one's open review requests, read as the user; and asking them for a review.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const CODEOWNERS = [
  "*          @fallback",
  "/src/      @lead @octo/core",
  "/src/db/   @dba",
  "*.md       docs@example.com",
].join("\n");

type Answer = (req: Request, body: Record<string, unknown> | null) => Response | undefined;
type Sent = { url: string; body: unknown };

function githubPlatform(over: { codeowners?: string | null; files?: string[] } = {}) {
  const sent: Sent[] = [];
  const searches: string[] = [];
  const files = over.files ?? ["src/db/query.ts", "src/app.ts", "README.md"];
  const answer: Answer = (req, body) => {
    const url = req.url;
    if (req.method === "GET" && url === PULL) {
      return Response.json({
        user: { login: "author", type: "User" },
        base: { sha: BASE, repo: { id: 1 } },
        head: { sha: HEAD },
        changed_files: files.length,
        requested_reviewers: [{ login: "lead", type: "User" }],
      });
    }
    if (req.method === "GET" && url === `${PULL}/files?per_page=100&page=1`) {
      return Response.json(files.map((filename) => ({ filename, status: "modified" })));
    }
    if (req.method === "POST" && url === `${PULL}/requested_reviewers`) {
      sent.push({ url, body });
      return Response.json({}, { status: 201 });
    }
    if (req.method === "POST" && url === "https://api.github.com/graphql") {
      const query = String(body?.query);
      const variables = (body?.variables ?? {}) as Record<string, string>;
      if (query.includes("search(")) {
        const data: Record<string, { issueCount: number }> = {};
        for (const [k, q] of Object.entries(variables)) {
          searches.push(q);
          data[`s${k.slice(1)}`] = { issueCount: q.endsWith(":dba") ? 7 : 1 };
        }
        return Response.json({ data });
      }
      expect(variables.oid).toBe(BASE);
      const blob = (i: number) =>
        i === 1 && over.codeowners !== null
          ? {
              oid: "d".repeat(40),
              byteSize: 100,
              isBinary: false,
              isTruncated: false,
              text: over.codeowners ?? CODEOWNERS,
            }
          : null;
      expect(variables.e0).toBe(`${BASE}:.github/CODEOWNERS`);
      return Response.json({ data: { repository: { b0: blob(0), b1: blob(1), b2: blob(2) } } });
    }
    return undefined;
  };
  githubFake({
    extra: async (req) =>
      answer(req, req.method === "GET" ? null : ((await req.json()) as Record<string, unknown>)),
  });
  return { sent, searches };
}

async function enroll(accountId: string, platformRepoId = "1") {
  const id = `repo-${accountId}`;
  await scoped(db, accountId).insert("reviewRepos", {
    id,
    platform: "github",
    host: "github.com",
    platformRepoId,
    fullName: "octo/api",
  });
  return id;
}

async function reviewed(accountId: string, repoId: string, reviewer: string, times: number) {
  const flows = scoped(db, accountId).pullFlows;
  for (let i = 0; i < times; i++) {
    const event = {
      reviewRepoId: repoId,
      number: 100 + i,
      title: "x",
      author: "someone",
      draft: false,
      size: null,
      seenAt: new Date(),
    };
    await flows.review(event, {
      reviewKey: `${reviewer}-${i}`,
      reviewer,
      approved: true,
      submittedAt: new Date(),
    });
  }
}

const accountId = async () => (await db.select().from(schema.accounts))[0]?.id ?? "";
const suggest = async (send: (p: string) => Promise<Response>, platform = "github") => {
  const repo = platform === "github" ? "octo/api" : "Group/Sub/Project";
  const res = await send(`/api/pulls/reviewers?platform=${platform}&repo=${repo}&number=7`);
  expect(res.status).toBe(200);
  return (await res.json()) as PullReviewersView;
};

describe("suggested reviewers on GitHub", () => {
  it("ranks the changed files' owners and the repository's recent reviewers, with their load", async () => {
    const { searches } = githubPlatform();
    const a = await signInWithGithub();
    const me = await accountId();
    const repo = await enroll(me);
    await reviewed(me, repo, "veteran", 4);
    await reviewed(me, repo, "dba", 1);
    await reviewed(me, repo, "author", 6);
    await reviewed(me, repo, "renovate[bot]", 9);
    const view = await suggest(a.send);
    expect(view.codeowners).toEqual({ path: "CODEOWNERS", read: true });
    expect(view.history).toBe("repository");
    expect(view.historyDays).toBe(90);
    expect(
      view.suggestions.map((s) => [s.login, s.reasons, s.score, s.load, s.alreadyRequested]),
    ).toEqual([
      ["lead", ["codeowner"], 10, 1, true],
      ["dba", ["codeowner", "recent_reviewer"], 7, 7, false],
      ["veteran", ["recent_reviewer"], 3, 1, false],
    ]);
    expect(view.owners).toEqual([
      { owner: "dba", kind: "user", files: 1 },
      { owner: "docs@example.com", kind: "email", files: 1 },
      { owner: "lead", kind: "user", files: 1 },
      { owner: "octo/core", kind: "team", files: 1 },
    ]);
    expect(searches.sort()).toEqual([
      "is:pr is:open archived:false review-requested:dba",
      "is:pr is:open archived:false review-requested:lead",
      "is:pr is:open archived:false review-requested:veteran",
    ]);
  });

  it("suggests only code owners for a repository the account has not enrolled", async () => {
    githubPlatform();
    const a = await signInWithGithub();
    const view = await suggest(a.send);
    expect(view.history).toBe("not_enrolled");
    expect(view.suggestions.map((s) => s.login)).toEqual(["lead", "dba"]);
  });

  it("answers no suggestions and no owners without a CODEOWNERS file or history", async () => {
    githubPlatform({ codeowners: null });
    const a = await signInWithGithub();
    const view = await suggest(a.send);
    expect(view).toMatchObject({ codeowners: null, owners: [], suggestions: [] });
  });

  it("never ranks with another account's reviews of the same repository", async () => {
    githubPlatform();
    const a = await signInWithGithub();
    const other = await signIn(9, "eve");
    const theirs = await enroll(other.account.id);
    await reviewed(other.account.id, theirs, "outsider", 8);
    const view = await suggest(a.send);
    expect(view.history).toBe("not_enrolled");
    expect(view.suggestions.map((s) => s.login)).not.toContain("outsider");
  });

  it("refuses a reference that is not a repository path", async () => {
    githubPlatform();
    const a = await signInWithGithub();
    const bad = await a.send("/api/pulls/reviewers?platform=github&repo=../x&number=7");
    expect(bad.status).toBe(404);
  });

  it("asks the chosen users for a review as the user", async () => {
    const { sent } = githubPlatform();
    const a = await signInWithGithub();
    const post = (body: unknown) =>
      a.send("/api/pulls/reviewers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await post({ platform: "github", repo: "octo/api", number: 7, logins: ["dba"] });
    expect(await res.json()).toEqual({ outcome: "done" });
    expect(sent).toEqual([{ url: `${PULL}/requested_reviewers`, body: { reviewers: ["dba"] } }]);
    const refused = await post({
      platform: "github",
      repo: "octo/api",
      number: 7,
      logins: ["not a login"],
    });
    expect(refused.status).toBe(400);
    expect(sent).toHaveLength(1);
  });
});

describe("suggested reviewers on GitLab", () => {
  it("reads sections at the base and each reviewer's open merge requests", async () => {
    const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("Group/Sub/Project")}/merge_requests/7`;
    const PROJECT = `${GITLAB}/api/v4/projects/9`;
    const asked: string[] = [];
    githubFake({
      extra: (req) => {
        const url = req.url;
        if (!url.startsWith(`${GITLAB}/api/v4/`)) return undefined;
        if (url === `${GITLAB}/api/v4/user`) return Response.json({ id: 77 });
        if (url === MR) {
          return Response.json({
            project_id: 9,
            author: { username: "author" },
            diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE },
            reviewers: [],
          });
        }
        if (url === `${MR}/diffs?per_page=100&page=1`) {
          return Response.json([
            {
              old_path: "api/x.go",
              new_path: "api/x.go",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
              diff: "",
            },
          ]);
        }
        if (url.startsWith(`${PROJECT}/repository/files/`)) {
          const path = decodeURIComponent(url.slice(`${PROJECT}/repository/files/`.length));
          expect(path.endsWith(`?ref=${BASE}`)).toBe(true);
          if (!path.startsWith(".gitlab/CODEOWNERS")) return new Response(null, { status: 404 });
          const text = "[Backend] @backend\n/api/ @gopher\n[Review]\n*.go @author @group/go";
          return Response.json({
            blob_id: "e".repeat(40),
            last_commit_id: BASE,
            size: text.length,
            encoding: "base64",
            content: btoa(text),
          });
        }
        if (url.startsWith(`${GITLAB}/api/v4/merge_requests?`)) {
          const q = new URL(url).searchParams;
          asked.push(`${q.get("reviewer_username")}:${q.get("state")}:${q.get("scope")}`);
          return Response.json([], { headers: { "x-total": "2" } });
        }
        return undefined;
      },
    });
    const a = await signInWithGithub();
    await (await connectGitlab(a))("code=c&state=STATE");
    const view = await suggest(a.send, "gitlab");
    expect(view.codeowners).toEqual({ path: ".gitlab/CODEOWNERS", read: true });
    expect(view.suggestions.map((s) => [s.login, s.score, s.load])).toEqual([["gopher", 9, 2]]);
    expect(view.owners.map((o) => [o.owner, o.kind])).toEqual([
      ["author", "user"],
      ["gopher", "user"],
      ["group/go", "team"],
    ]);
    expect(asked).toEqual(["gopher:opened:all"]);
  });
});

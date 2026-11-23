import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identities } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseTitle } from "../src/release-notes-draft.js";
import { reviewRow } from "../src/reviews.js";
import {
  MAX_RELEASE_BODY_CHARS,
  type ReleaseNotesView,
  type ReleasePublishAnswer,
} from "../src/shared/index.js";
import { upload } from "./finding-uploads.js";
import { db, resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// Release notes on GitHub: the pull requests merged as commits of the range
// (one compare, one GraphQL query), grouped by their titles' types with no
// one mentioned, and saved as a draft release only where no tag or
// published release of that name exists.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com/repos/octo/api";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const ELSEWHERE = "e".repeat(40);

type Sent = { method: string; url: string; body: unknown };
type Node = Record<string, unknown>;

const pr = (number: number, title: string, mergeCommit: string | null, over: Node = {}) => ({
  number,
  title,
  url: `https://github.com/octo/api/pull/${number}`,
  merged: mergeCommit !== null,
  mergedAt: "2026-11-20T10:00:00Z",
  body: "",
  mergeCommit: mergeCommit ? { oid: mergeCommit } : null,
  author: { login: `dev${number}` },
  ...over,
});

const RANGE: Record<string, Node[]> = {
  [A]: [pr(12, "feat(api): add release notes", A)],
  [B]: [
    pr(13, "fix: keep @team out of it <b>now</b>", B),
    pr(90, "feat: on another branch", ELSEWHERE),
  ],
  [C]: [pr(14, "refactor: tidy the router", C), pr(15, "feat: still open", null)],
  [D]: [
    pr(16, "chore!: drop Node 20", D, { author: null }),
    pr(12, "feat(api): add release notes", A),
  ],
};

/** GitHub's answers by `METHOD url`; every write and GraphQL query is recorded. */
function github(routes: Record<string, () => Response> = {}, commits = [A, B, C, D]) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const body: unknown = req.method === "GET" ? null : await req.json().catch(() => null);
      if (req.url === "https://api.github.com/graphql") {
        sent.push({ method: req.method, url: req.url, body });
        const query = (body as { query: string }).query;
        const repository: Record<string, unknown> = {};
        for (const [, alias, oid] of query.matchAll(/(c\d+): object\(oid: "([0-9a-f]+)"\)/g)) {
          repository[alias as string] = {
            associatedPullRequests: { nodes: RANGE[oid as string] ?? [] },
          };
        }
        return Response.json({ data: { repository } });
      }
      const key = `${req.method} ${req.url}`;
      if (key === `GET ${API}/compare/v1.0.0...main?per_page=250`) {
        return Response.json({
          total_commits: commits.length,
          commits: commits.map((sha) => ({ sha })),
        });
      }
      const route = routes[key];
      if (!route) return undefined;
      if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body });
      return route();
    },
  });
  return sent;
}

type Signed = Awaited<ReturnType<typeof signInWithGithub>>;
const draft = (a: Signed, query = "") =>
  a.send(`/api/release-notes?platform=github&repo=octo/api&from=v1.0.0&to=main${query}`);
const publish = (a: Signed, over: Record<string, unknown> = {}) =>
  a.send("/api/release-notes/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "github",
      repo: "octo/api",
      tag: "v1.1.0",
      target: "main",
      name: "v1.1.0",
      body: "Notes, edited.",
      draft: true,
      ...over,
    }),
  });

describe("release notes drafted on GitHub", () => {
  it("lists only the pull requests merged as commits of the range, grouped by type", async () => {
    const sent = github();
    const a = await signInWithGithub();
    const res = await draft(a);
    expect(res.status).toBe(200);
    const view = (await res.json()) as ReleaseNotesView;
    expect(view).toMatchObject({
      platform: "github",
      repo: "octo/api",
      truncated: false,
      drafts: true,
    });
    expect(view.pulls.map((p) => [p.number, p.section])).toEqual([
      [12, "added"],
      [13, "fixed"],
      [14, "hidden"],
      [16, "breaking"],
    ]);
    // One GraphQL query for the whole range.
    expect(sent.filter((s) => s.url.endsWith("/graphql"))).toHaveLength(1);
    expect(view.body).toBe(
      [
        "### Breaking changes\n\n- drop Node 20 ([#16](https://github.com/octo/api/pull/16))",
        "### Added\n\n- **api:** add release notes ([#12](https://github.com/octo/api/pull/12), by @\u200Bdev12)",
        "### Fixed\n\n- keep \\@\u200Bteam out of it &lt;b&gt;now&lt;/b&gt; ([#13](https://github.com/octo/api/pull/13), by @\u200Bdev13)",
        "**Full changes:** [v1.0.0...main](https://github.com/octo/api/compare/v1.0.0...main)",
      ].join("\n\n"),
    );
    expect(view.body).not.toMatch(/@\w/);
  });

  it("lists the maintenance types when asked for", async () => {
    github();
    const a = await signInWithGithub();
    const view = (await (await draft(a, "&hidden=true")).json()) as ReleaseNotesView;
    expect(view.body).toContain(
      "### Maintenance\n\n- tidy the router ([#14](https://github.com/octo/api/pull/14), by @\u200Bdev14)",
    );
  });

  it("reads a BREAKING CHANGE footer in a description as breaking", async () => {
    RANGE[A] = [
      pr(12, "feat(api): add release notes", A, { body: "x\n\nBREAKING CHANGE: v1 is gone" }),
    ];
    try {
      github();
      const a = await signInWithGithub();
      const view = (await (await draft(a)).json()) as ReleaseNotesView;
      expect(view.pulls.find((p) => p.number === 12)).toMatchObject({
        breaking: true,
        section: "breaking",
      });
    } finally {
      RANGE[A] = [pr(12, "feat(api): add release notes", A)];
    }
  });

  it("names the account's own review of each pull request when asked", async () => {
    github();
    const a = await signInWithGithub();
    const [identity] = await db.select().from(identities).where(eq(identities.subject, "42"));
    const data = scoped(db, identity?.accountId ?? "");
    const { reviewersDropped: _, ...row } = reviewRow(
      reviewUploadSchema.parse({
        ...upload("run-1", []),
        verdict: "minor_issues",
        findings: { critical: 0, warning: 2, suggestion: 1 },
        pullRequest: { repository: "https://github.com/octo/api", number: 12, headSha: A },
      }),
    );
    expect((await data.insertReview(row, [], { dailyUploads: 10, maxFindings: 10 })).outcome).toBe(
      "stored",
    );
    const view = (await (await draft(a, "&reviews=true")).json()) as ReleaseNotesView;
    expect(view.pulls.find((p) => p.number === 12)?.review).toEqual({
      verdict: "minor_issues",
      findings: 3,
    });
    expect(view.pulls.find((p) => p.number === 13)?.review).toBeNull();
    expect(view.body).toContain("by @\u200Bdev12; ocra: minor issues, 3 findings)");
    const plain = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(plain.body).not.toContain("ocra:");
  });

  it("says when the range held more commits than one draft reads", async () => {
    githubFake({
      extra: (req) =>
        req.url.startsWith(`${API}/compare/`)
          ? Response.json({ total_commits: 400, commits: [] })
          : undefined,
    });
    const a = await signInWithGithub();
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.truncated).toBe(true);
    expect(view.body).toContain("No pull requests were merged in this range.");
    expect(view.body).toContain("This draft lists the first 0 pull requests of the range.");
  });

  it("answers not found for a ref the repository lacks, and refuses ref names git would not take", async () => {
    githubFake({
      extra: (req) =>
        req.url.startsWith(`${API}/compare/`) ? Response.json({}, { status: 404 }) : undefined,
    });
    const a = await signInWithGithub();
    expect((await draft(a)).status).toBe(404);
    for (const bad of ["a..b", "-x", "x/", "x.lock", "a b", "x@{1}", "%2e%2e"]) {
      const res = await a.send(
        `/api/release-notes?platform=github&repo=octo/api&from=${encodeURIComponent(bad)}&to=main`,
      );
      expect(res.status, bad).toBe(404);
    }
  });
});

describe("a draft release saved on GitHub", () => {
  const target = { [`GET ${API}/commits/main`]: () => new Response(A) };

  it("creates a draft release when neither the tag nor a release of it exists", async () => {
    const sent = github({
      ...target,
      [`GET ${API}/releases?per_page=100`]: () =>
        Response.json([{ id: 1, tag_name: "v1.0.0", draft: false }]),
      [`GET ${API}/git/ref/tags/v1.1.0`]: () => Response.json({}, { status: 404 }),
      [`POST ${API}/releases`]: () =>
        Response.json(
          { id: 77, html_url: "https://github.com/octo/api/releases/tag/untagged-1" },
          { status: 201 },
        ),
    });
    const a = await signInWithGithub();
    const res = await publish(a);
    expect((await res.json()) as ReleasePublishAnswer).toEqual({
      outcome: "created",
      release: { id: 77, url: "https://github.com/octo/api/releases/tag/untagged-1" },
    });
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${API}/releases`,
        body: {
          tag_name: "v1.1.0",
          name: "v1.1.0",
          body: "Notes, edited.",
          target_commitish: "main",
          draft: true,
        },
      },
    ]);
  });

  it("edits the draft release of that tag instead of making another", async () => {
    const sent = github({
      ...target,
      [`GET ${API}/releases?per_page=100`]: () =>
        Response.json([{ id: 5, tag_name: "v1.1.0", draft: true }]),
      [`PATCH ${API}/releases/5`]: () =>
        Response.json({ id: 5, html_url: "https://evil.example/x" }),
    });
    const a = await signInWithGithub();
    expect((await (await publish(a)).json()) as ReleasePublishAnswer).toEqual({
      outcome: "updated",
      release: { id: 5, url: "https://github.com/octo/api/releases" },
    });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`PATCH ${API}/releases/5`]);
  });

  it("refuses unsent a tag that exists, or has a published release", async () => {
    const published = github({
      ...target,
      [`GET ${API}/releases?per_page=100`]: () =>
        Response.json([{ id: 5, tag_name: "v1.1.0", draft: false }]),
    });
    const a = await signInWithGithub();
    expect(await (await publish(a)).json()).toEqual({ outcome: "tag_exists" });
    expect(published).toEqual([]);
    vi.restoreAllMocks();
    const tagged = github({
      ...target,
      [`GET ${API}/releases?per_page=100`]: () => Response.json([]),
      [`GET ${API}/git/ref/tags/v1.1.0`]: () => Response.json({ ref: "refs/tags/v1.1.0" }),
    });
    expect(await (await publish(a)).json()).toEqual({ outcome: "tag_exists" });
    expect(tagged).toEqual([]);
  });

  it("refuses unsent a target that is no branch or commit", async () => {
    const sent = github({ [`GET ${API}/commits/main`]: () => Response.json({}, { status: 422 }) });
    const a = await signInWithGithub();
    expect(await (await publish(a)).json()).toEqual({ outcome: "target_missing" });
    expect(sent).toEqual([]);
  });

  it("answers the platform's refusal as one", async () => {
    github({
      ...target,
      [`GET ${API}/releases?per_page=100`]: () => Response.json({}, { status: 403 }),
    });
    const a = await signInWithGithub();
    expect(await (await publish(a)).json()).toEqual({ outcome: "refused" });
  });

  it("refuses a request that is no draft, a bad tag or a body too long", async () => {
    const sent = github(target);
    const a = await signInWithGithub();
    for (const over of [
      { draft: false },
      { tag: "v1..2" },
      { name: "two\nlines" },
      { body: "x".repeat(MAX_RELEASE_BODY_CHARS + 1) },
    ]) {
      expect((await publish(a, over)).status, JSON.stringify(over).slice(0, 40)).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("a pull request's title", () => {
  it("is read as a Conventional Commit when it is one", () => {
    expect(parseTitle("feat(web)!: new shell")).toEqual({
      type: "feat",
      scope: "web",
      subject: "new shell",
      breaking: true,
    });
    expect(parseTitle("Fix: the thing")).toMatchObject({ type: "fix", breaking: false });
    expect(parseTitle("Bump lodash")).toEqual({
      type: null,
      scope: null,
      subject: "Bump lodash",
      breaking: false,
    });
  });
});

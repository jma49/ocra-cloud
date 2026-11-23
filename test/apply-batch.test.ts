import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditPage,
  type BatchItem,
  MAX_BATCH_ITEMS,
  type PullBatchView,
} from "../src/shared/index.js";
import { FILE, HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// Several of ocra's fixes and review suggestions committed to a GitHub pull
// request as one commit: one file through its contents API, several through
// its git database, each item answered applied or why not.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MOVED = "b".repeat(40);
const API = "https://api.github.com/repos/octo/api";
const GRAPHQL = "https://api.github.com/graphql";
const PULL = `${API}/pulls/7`;
const contents = (path: string) => `${API}/contents/${path}`;
const OTHER = "first\nsecond\n";
const FP = "0123456789abcdef";
const ref = { platform: "github", repo: "octo/api", number: 7 };

type Body = { query?: string; variables?: Record<string, string> } & Record<string, unknown>;
type Sent = { method: string; url: string; body: Body };

function platform(routes: Record<string, (body: Body) => Response>) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return undefined;
      const body = (req.method === "GET" ? {} : await req.json()) as Body;
      if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body });
      return route(body);
    },
  });
  return sent;
}

const HUNK = "@@ -1,4 +1,4 @@\n const a = 1;\n-const b = 1;\n+const b = 2;";
const suggestionThread = (id: string, line: number, text: string, hunk = HUNK) => ({
  id: `T${id}`,
  isResolved: false,
  isOutdated: false,
  path: "src/db.ts",
  line,
  startLine: null,
  originalLine: line,
  originalStartLine: null,
  diffSide: "RIGHT",
  startDiffSide: null,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: {
    totalCount: 1,
    nodes: [
      {
        id,
        author: { login: "rev" },
        body: `<!-- ocra:finding ${FP} -->\n\`\`\`suggestion\n${text}\n\`\`\``,
        createdAt: "2026-11-20T10:00:00Z",
        diffHunk: hunk,
      },
    ],
  },
});
const THREADS = [
  // The same change as the seeded finding's fix.
  suggestionThread("S1", 2, "const b = 20;"),
  // Another change of line 2.
  suggestionThread("S2", 2, "const b = 99;"),
  suggestionThread("S3", 3, "const c = 30;", `${HUNK}\n const c = 3;`),
];

/** GitHub's GraphQL: the threads, or the head's tree with each file's mode. */
const graphql =
  (head = HEAD) =>
  (body: Body) => {
    if (body.query?.includes("reviewThreads") || body.query?.includes("pullRequest")) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              headRefOid: head,
              reviewThreads: { pageInfo: { hasNextPage: false }, nodes: THREADS },
            },
          },
        },
      });
    }
    const entries = [{ name: "README.md", mode: 0o100644, type: "blob" }];
    const src = [
      { name: "db.ts", mode: 0o100644, type: "blob" },
      { name: "run.sh", mode: 0o100755, type: "blob" },
    ];
    return Response.json({
      data: { repository: { root: { tree: { oid: "tree0", entries } }, d0: { entries: src } } },
    });
  };

const fileRead = (text: string, sha: string) => () =>
  Response.json({ type: "file", sha, size: text.length, encoding: "base64", content: btoa(text) });

const pullAt =
  (sha = HEAD) =>
  () =>
    Response.json({ head: { sha, ref: "feature/x", repo: { full_name: "octo/api" } } });

const apply = (a: Awaited<ReturnType<typeof signInWithGithub>>, items: BatchItem[], head = HEAD) =>
  a.send("/api/pulls/apply-batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ref, head, items }),
  });

const fixes = (id: string): BatchItem => ({ kind: "finding", id });
const suggests = (id: string): BatchItem => ({ kind: "suggestion", id });
const outcomes = async (res: Response) => (await res.json()) as PullBatchView;
const reasons = (view: PullBatchView) => view.items.map((i) => i.reason);

/** The seeded finding on src/db.ts, and another whose fix replaces run.sh's first line. */
async function twoFindings() {
  const db = await seed("https://github.com/octo/api", 7);
  const sh = await seed(
    "https://github.com/octo/api",
    7,
    {
      file: "src/run.sh",
      fingerprint: "fp-run",
      fixStartLine: 1,
      fixEndLine: 1,
      fixReplacement: "FIRST",
    },
    "run-2",
  );
  return { db, sh };
}

const gitRoutes = (overrides: Record<string, (body: Body) => Response> = {}) => ({
  [`POST ${GRAPHQL}`]: graphql(),
  [`GET ${PULL}`]: pullAt(),
  [`GET ${contents("src/db.ts")}?ref=${HEAD}`]: fileRead(FILE, "blob-db"),
  [`GET ${contents("src/run.sh")}?ref=${HEAD}`]: fileRead(OTHER, "blob-sh"),
  [`POST ${API}/git/trees`]: () => Response.json({ sha: "tree1" }, { status: 201 }),
  [`POST ${API}/git/commits`]: () => Response.json({ sha: "commit1" }, { status: 201 }),
  [`PATCH ${API}/git/refs/heads/feature/x`]: () => Response.json({ object: { sha: "commit1" } }),
  ...overrides,
});

describe("applying several fixes and suggestions as one commit on GitHub", () => {
  it("commits fixes in two files and suggestions as one fast forward of the head, each file keeping its mode", async () => {
    const sent = platform(gitRoutes());
    const a = await signInWithGithub();
    const { db, sh } = await twoFindings();
    const view = await outcomes(
      await apply(a, [fixes(db.id), suggests("S1:0"), fixes(sh.id), suggests("S3:0")]),
    );
    expect(view.outcome).toBe("done");
    expect(view.items.map((i) => i.applied)).toEqual([true, true, true, true]);
    expect(sent.map((s) => `${s.method} ${s.url.replace(API, "")}`)).toEqual([
      `POST ${GRAPHQL}`,
      `POST ${GRAPHQL}`,
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/feature/x",
    ]);
    const [, modes, tree, commit, moved] = sent;
    expect(modes?.body.variables).toMatchObject({ head: HEAD, e0: `${HEAD}:src` });
    expect(tree?.body).toEqual({
      base_tree: "tree0",
      tree: [
        {
          path: "src/db.ts",
          mode: "100644",
          type: "blob",
          // The finding's fix and the same suggestion once, and the other suggestion.
          content: "const a = 1;\nconst b = 20;\nconst c = 30;\n",
        },
        { path: "src/run.sh", mode: "100755", type: "blob", content: "FIRST\nsecond\n" },
      ],
    });
    expect(commit?.body).toEqual({
      message: "Apply 2 fixes from ocra and 2 suggestions",
      tree: "tree1",
      parents: [HEAD],
    });
    expect(moved?.body).toEqual({ sha: "commit1", force: false });
    expect(await db.data.get("findings", db.id)).toMatchObject({ fixedVia: "applied" });
    expect(await db.data.get("findings", sh.id)).toMatchObject({ fixedVia: "applied" });
    const log = (await (await a.send("/api/audit")).json()) as AuditPage;
    expect(log.events.filter((e) => e.kind === "pull.fix_applied")).toHaveLength(2);
  });

  it("applies the earlier of two items that change the same lines differently, whichever comes first", async () => {
    const write = { [`PUT ${contents("src/db.ts")}`]: () => Response.json({ commit: {} }) };
    const sent = platform(gitRoutes(write));
    const a = await signInWithGithub();
    const { db } = await twoFindings();
    const first = await outcomes(await apply(a, [suggests("S2:0"), fixes(db.id)]));
    expect(first.outcome).toBe("done");
    expect(first.items).toEqual([
      { kind: "suggestion", id: "S2:0", applied: true, reason: null },
      { kind: "finding", id: db.id, applied: false, reason: "conflict" },
    ]);
    const second = await outcomes(await apply(a, [fixes(db.id), suggests("S2:0")]));
    expect(reasons(second)).toEqual([null, "conflict"]);
    const puts = sent.filter((s) => s.method === "PUT").map((s) => atob(String(s.body.content)));
    expect(puts).toEqual([
      "const a = 1;\nconst b = 99;\nconst c = 3;\n",
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    ]);
    // One file changed: its blob sha guards the write, as for one fix.
    expect(sent.find((s) => s.method === "PUT")?.body).toMatchObject({
      sha: "blob-db",
      branch: "feature/x",
      message: "Apply a suggestion from review",
    });
  });

  it("says why each item it left out was, and commits the rest", async () => {
    const changed = "const a = 1;\nconst b = 7;\nconst c = 3;\n";
    const sent = platform(
      gitRoutes({
        [`GET ${contents("src/db.ts")}?ref=${HEAD}`]: fileRead(changed, "blob-db"),
        [`PUT ${contents("src/run.sh")}`]: () => Response.json({ commit: {} }),
      }),
    );
    const a = await signInWithGithub();
    const { sh } = await twoFindings();
    const noFix = await seed(
      "https://github.com/octo/api",
      7,
      { fingerprint: "fp-none", fixStartLine: null, fixEndLine: null, fixReplacement: null },
      "run-3",
    );
    const elsewhere = await seed("https://github.com/octo/api", 8, {}, "run-4");
    const view = await outcomes(
      await apply(a, [
        suggests("S1:0"),
        fixes(sh.id),
        fixes(noFix.id),
        fixes(elsewhere.id),
        fixes("missing"),
        suggests("S9:0"),
      ]),
    );
    expect(view.outcome).toBe("done");
    // S1's line 2 is no longer the line it was written on.
    expect(reasons(view)).toEqual(["stale", null, "no_fix", "not_found", "not_found", "not_found"]);
    expect(sent.filter((s) => s.method === "PUT").map((s) => s.body.message)).toEqual([
      "Apply ocra's fix: SQL built from input",
    ]);
  });

  it("sends nothing for fixes written for another head", async () => {
    const sent = platform(gitRoutes({ [`GET ${PULL}`]: pullAt(MOVED) }));
    const a = await signInWithGithub();
    const { db } = await twoFindings();
    const view = await outcomes(await apply(a, [fixes(db.id)], MOVED));
    expect(view).toEqual({
      outcome: "not_applicable",
      items: [{ kind: "finding", id: db.id, applied: false, reason: "stale" }],
    });
    expect(sent).toEqual([]);
  });

  it("commits nothing on a pull request that moved since the page was read", async () => {
    const moved = platform(gitRoutes({ [`GET ${PULL}`]: pullAt(MOVED) }));
    const a = await signInWithGithub();
    const { db, sh } = await twoFindings();
    const view = await outcomes(await apply(a, [fixes(db.id), fixes(sh.id)]));
    expect(view.outcome).toBe("head_moved");
    expect(reasons(view)).toEqual(["not_sent", "not_sent"]);
    expect(moved).toEqual([]);
  });

  it("does not move a branch that gained a commit while the batch was committed", async () => {
    const raced = platform(
      gitRoutes({
        [`PATCH ${API}/git/refs/heads/feature/x`]: () =>
          Response.json({ message: "Update is not a fast forward" }, { status: 422 }),
      }),
    );
    const a = await signInWithGithub();
    const { db, sh } = await twoFindings();
    const again = await outcomes(await apply(a, [fixes(db.id), fixes(sh.id)]));
    expect(again.outcome).toBe("head_moved");
    expect(again.items.every((i) => !i.applied && i.reason === "not_sent")).toBe(true);
    expect(raced.at(-1)?.body).toMatchObject({ force: false });
    expect((await db.data.get("findings", db.id))?.status).toBe("open");
  });

  it("refuses an empty batch, a repeated item, or one too many", async () => {
    platform({});
    const a = await signInWithGithub();
    expect((await apply(a, [])).status).toBe(400);
    expect((await apply(a, [fixes("x"), fixes("x")])).status).toBe(400);
    const many = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => fixes(`f${i}`));
    expect((await apply(a, many)).status).toBe(400);
  });
});

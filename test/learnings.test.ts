import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSalt } from "../src/db/accounts.js";
import { accounts } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseLearning } from "../src/learning-file.js";
import { repoHashOf } from "../src/platforms/platform.js";
import type {
  LearningChangeView,
  LearningProposalsView,
  LearningsView,
} from "../src/shared/index.js";
import { db, resetDb } from "./helpers.js";
import {
  BLOB,
  githubBlobs,
  githubHead,
  HEAD,
  learningText,
  OTHER,
  PR_HEAD,
  platform,
} from "./learning-fakes.js";
import { signInWithGithub } from "./platform-fakes.js";

// A repository's learnings, managed from the console as the signed-in user
// on GitHub: read at the default branch, the open proposals, and changes
// committed on a new branch opened as a pull request, guarded by the blob read.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const REPO = "https://api.github.com/repos/octo/api";
const DIR = `${REPO}/contents/.ocra/learnings?ref=${HEAD}`;
const FILE = `${REPO}/contents/.ocra/learnings/close-pools.md`;
const POOLS = ".ocra/learnings/close-pools.md";

const dir = (...names: string[]) =>
  Response.json(
    names.map((n, i) => ({
      type: "file",
      path: `.ocra/learnings/${n}`,
      sha: String(i).repeat(40),
    })),
  );

const learning = {
  title: "Close every pool",
  paths: ["src/db/**"],
  keywords: ["pool"],
  created: "2026-10-01",
  body: "Pools leak when a handler throws.",
};

const change = (a: Awaited<ReturnType<typeof signInWithGithub>>, path: string, body: unknown) =>
  a.send(`/api/learnings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("listing a repository's learnings", () => {
  it("parses each file at the default branch, with its blob and last commit", async () => {
    platform(
      {
        ...githubHead,
        [`GET ${DIR}`]: () => dir("close-pools.md", "broken.md", "Bad Name.md", "README.txt"),
      },
      githubBlobs({
        [POOLS]: { oid: BLOB, text: learningText() },
        ".ocra/learnings/broken.md": { oid: OTHER, text: "no frontmatter" },
      }),
    );
    const a = await signInWithGithub();
    const res = await a.send("/api/learnings?platform=github&repo=octo/api");
    expect(res.status).toBe(200);
    const view = (await res.json()) as LearningsView;
    expect(view).toMatchObject({
      repo: "octo/api",
      branch: "main",
      commit: HEAD,
      total: 2,
      next: null,
    });
    expect(view.learnings).toEqual([
      {
        id: "close-pools",
        path: POOLS,
        blobId: BLOB,
        title: "Close every pool",
        body: "Pools leak when a handler throws.",
        paths: ["src/db/**"],
        symbols: [],
        keywords: ["pool"],
        critical: false,
        source: null,
        created: "2026-10-01",
        lastCommit: { sha: OTHER, at: "2026-11-01T00:00:00Z" },
      },
    ]);
    expect(view.invalid.map((i) => i.path).sort()).toEqual([
      ".ocra/learnings/Bad Name.md",
      ".ocra/learnings/broken.md",
    ]);
  });

  it("says how many of the repository's reviews were given each learning lately", async () => {
    platform(
      { ...githubHead, [`GET ${DIR}`]: () => dir("close-pools.md", "retry.md") },
      githubBlobs({
        [POOLS]: { oid: BLOB, text: learningText() },
        ".ocra/learnings/retry.md": { oid: OTHER, text: learningText() },
      }),
    );
    const a = await signInWithGithub();
    const [account] = await db.select().from(accounts);
    const id = account?.id ?? "";
    const repoHash = await repoHashOf(
      await accountSalt(db, id),
      { url: "https://github.com" },
      "Octo/API",
    );
    const at = new Date(Date.now() - 86_400_000);
    const reviews: { repoHash: string; learnings: string[]; createdAt?: Date }[] = [
      { repoHash, learnings: ["close-pools"], createdAt: at },
      { repoHash, learnings: ["close-pools"], createdAt: new Date(at.getTime() - 1000) },
      { repoHash: "b".repeat(64), learnings: ["retry"] },
    ];
    for (const [n, over] of reviews.entries()) {
      await scoped(db, id).insert("reviews", { runId: `r${n}`, source: "github", ...over });
    }
    const view = (await (
      await a.send("/api/learnings?platform=github&repo=octo/api")
    ).json()) as LearningsView;
    expect(view.usageDays).toBe(90);
    expect(view.usage).toEqual({
      "close-pools": { reviews: 2, lastUsedAt: at.toISOString() },
      retry: { reviews: 0, lastUsedAt: null },
    });
  });

  it("says what the server does with the repository's declined findings, when it reviews it", async () => {
    platform({ ...githubHead, [`GET ${DIR}`]: () => dir() });
    const a = await signInWithGithub();
    const read = async () =>
      (
        (await (
          await a.send("/api/learnings?platform=github&repo=octo/api")
        ).json()) as LearningsView
      ).declined;
    expect(await read()).toBeNull();

    const [account] = await db.select().from(accounts);
    const data = scoped(db, account?.id ?? "");
    await data.insert("reviewRepos", {
      platform: "github",
      host: "github.com",
      platformRepoId: "1",
      fullName: "octo/api",
      learn: "propose",
    });
    const repo = await data.findOne("reviewRepos", { fullName: "octo/api" });
    await data.learning.queue(repo?.id ?? "", 7, new Date());
    expect(await read()).toEqual({
      reviewRepoId: repo?.id,
      learn: "propose",
      jobs: [{ number: 7, state: "queued", error: null, finishedAt: null }],
    });
  });

  it("answers an empty list for a repository without the directory", async () => {
    platform({ ...githubHead, [`GET ${DIR}`]: () => new Response(null, { status: 404 }) });
    const a = await signInWithGithub();
    const view = (await (
      await a.send("/api/learnings?platform=github&repo=octo/api")
    ).json()) as LearningsView;
    expect(view.learnings).toEqual([]);
    expect(view.total).toBe(0);
  });

  it("pages by id", async () => {
    const names = Array.from({ length: 60 }, (_, i) => `l-${String(i).padStart(2, "0")}.md`);
    const asked: number[] = [];
    platform({ ...githubHead, [`GET ${DIR}`]: () => dir(...names) }, (variables) => {
      asked.push(Object.keys(variables).filter((k) => k.startsWith("p")).length);
      return githubBlobs({})(variables);
    });
    const a = await signInWithGithub();
    const first = (await (
      await a.send("/api/learnings?platform=github&repo=octo/api")
    ).json()) as LearningsView;
    expect(first.next).toBe("l-49");
    const second = (await (
      await a.send("/api/learnings?platform=github&repo=octo/api&after=l-49")
    ).json()) as LearningsView;
    expect(second.next).toBeNull();
    expect(asked).toEqual([50, 10]);
  });

  it("answers not found for a repository the user does not reach, as for another account's", async () => {
    platform({ [`GET ${REPO}`]: () => new Response(null, { status: 404 }) });
    const a = await signInWithGithub();
    expect((await a.send("/api/learnings?platform=github&repo=octo/api")).status).toBe(404);
    expect((await a.send("/api/learnings?platform=github&repo=octo/../etc")).status).toBe(404);
  });
});

describe("changing a learning on GitHub", () => {
  it("adds one on a new branch from the head it read, and opens a pull request", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => new Response(null, { status: 404 }),
      [`POST ${REPO}/git/refs`]: () => Response.json({}, { status: 201 }),
      [`PUT ${FILE}`]: () => Response.json({}, { status: 201 }),
      [`POST ${REPO}/pulls`]: () =>
        Response.json(
          { number: 12, html_url: "https://github.com/octo/api/pull/12" },
          { status: 201 },
        ),
    });
    const a = await signInWithGithub();
    const res = await change(a, "", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: null,
      learning,
    });
    expect((await res.json()) as LearningChangeView).toEqual({
      outcome: "done",
      path: POOLS,
      pull: { number: 12, url: "https://github.com/octo/api/pull/12" },
    });
    const [ref, put, pull] = sent as { body: Record<string, string> }[];
    expect(ref?.body.ref).toMatch(/^refs\/heads\/ocra\/learnings-\d{14}-[0-9a-f]{6}$/);
    expect(ref?.body.sha).toBe(HEAD);
    const branch = ref?.body.ref?.slice("refs/heads/".length);
    expect(put?.body).toMatchObject({ branch });
    expect(put?.body).not.toHaveProperty("sha");
    const parsed = parseLearning(
      Uint8Array.from(atob(put?.body.content ?? ""), (ch) => ch.charCodeAt(0)),
    );
    expect(parsed).toMatchObject({
      frontmatter: { title: "Close every pool", created: "2026-10-01" },
    });
    expect(pull?.body).toMatchObject({ head: branch, base: "main" });
  });

  it("answers a conflict, writing nothing, when the file is not the blob the edit was made on", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: OTHER }),
    });
    const a = await signInWithGithub();
    const res = await change(a, "", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: BLOB,
      learning,
    });
    expect(await res.json()).toMatchObject({ outcome: "conflict", pull: null });
    expect(sent).toEqual([]);
  });

  it("answers a conflict, and drops its branch, when the file moves between read and write", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: BLOB }),
      [`POST ${REPO}/git/refs`]: () => Response.json({}, { status: 201 }),
      [`PUT ${FILE}`]: () => Response.json({ message: "does not match" }, { status: 409 }),
      [`DELETE ${REPO}/git/refs/heads/ocra/learnings-*`]: () => new Response(null, { status: 204 }),
    });
    const a = await signInWithGithub();
    const res = await change(a, "", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: BLOB,
      learning,
    });
    expect(await res.json()).toMatchObject({ outcome: "conflict" });
    expect(sent[1]?.body).toMatchObject({ sha: BLOB });
    expect(sent.at(-1)?.method).toBe("DELETE");
    expect(sent.at(-1)?.url).toMatch(/\/git\/refs\/heads\/ocra\/learnings-/);
    expect(sent.some((s) => s.url.endsWith("/pulls"))).toBe(false);
  });

  it("commits on the default branch when asked, and the platform's refusal answers refused", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: BLOB }),
      [`PUT ${FILE}`]: () => Response.json({ message: "protected" }, { status: 403 }),
    });
    const a = await signInWithGithub();
    const res = await change(a, "", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: BLOB,
      direct: true,
      learning,
    });
    expect(await res.json()).toMatchObject({ outcome: "refused", pull: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ branch: "main", sha: BLOB });
  });

  it("deletes one with the blob it read", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: BLOB }),
      [`DELETE ${FILE}`]: () => Response.json({}),
    });
    const a = await signInWithGithub();
    const res = await change(a, "/delete", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: BLOB,
      direct: true,
    });
    expect(await res.json()).toEqual({ outcome: "done", path: POOLS, pull: null });
    expect(sent[0]).toMatchObject({ method: "DELETE", body: { sha: BLOB, branch: "main" } });
  });

  it("refuses a name that leaves the learnings directory without calling the platform", async () => {
    platform({});
    const fetched = vi.mocked(globalThis.fetch);
    const a = await signInWithGithub();
    const calls = fetched.mock.calls.length;
    for (const id of ["../../src/index", "a/b", "close-pools.md", "..", "Close"]) {
      const res = await change(a, "", {
        platform: "github",
        repo: "octo/api",
        id,
        expected: null,
        learning,
      });
      expect(res.status).toBe(400);
    }
    const deleted = await change(a, "/delete", {
      platform: "github",
      repo: "octo/api",
      id: "../x",
      expected: BLOB,
    });
    expect(deleted.status).toBe(400);
    expect(fetched.mock.calls.length).toBe(calls);
  });

  it("refuses a learning a review would not read", async () => {
    platform({});
    const a = await signInWithGithub();
    const res = await change(a, "", {
      platform: "github",
      repo: "octo/api",
      id: "close-pools",
      expected: null,
      learning: { ...learning, paths: [] },
    });
    expect(res.status).toBe(400);
  });
});

describe("a repository's learning proposals on GitHub", () => {
  it("lists open pull requests from its own proposal branches, with the learnings they add", async () => {
    const pull = (number: number, ref: string, repo = "octo/api") => ({
      number,
      title: `chore(ocra): add learnings ${number}`,
      html_url: `https://github.com/octo/api/pull/${number}`,
      created_at: "2026-11-20T00:00:00Z",
      user: { login: "octo" },
      head: { ref, sha: PR_HEAD, repo: { full_name: repo } },
    });
    platform(
      {
        ...githubHead,
        [`GET ${REPO}/pulls?state=open&base=main&per_page=100&sort=created&direction=desc`]: () =>
          Response.json([
            pull(5, "ocra/learnings-20261120000000"),
            pull(6, "ocra/learnings-x", "mallory/api"),
            pull(7, "feature"),
          ]),
        [`GET ${REPO}/pulls/5`]: () =>
          Response.json({ base: { sha: HEAD }, head: { sha: PR_HEAD }, changed_files: 3 }),
        [`GET ${REPO}/pulls/5/files?per_page=100&page=1`]: () =>
          Response.json([
            {
              filename: POOLS,
              status: "added",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: "@@ -0,0 +1 @@",
            },
            {
              filename: ".ocra/learnings/old.md",
              status: "removed",
              additions: 0,
              deletions: 1,
              changes: 1,
            },
            { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
          ]),
      },
      githubBlobs({ [POOLS]: { oid: BLOB, text: learningText() } }),
    );
    const a = await signInWithGithub();
    const res = await a.send("/api/learnings/proposals?platform=github&repo=octo/api");
    const view = (await res.json()) as LearningProposalsView;
    expect(view.more).toBe(false);
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]).toMatchObject({
      number: 5,
      branch: "ocra/learnings-20261120000000",
      head: PR_HEAD,
      author: "octo",
      removed: ["old"],
      invalid: [],
    });
    expect(view.proposals[0]?.learnings.map((l) => l.id)).toEqual(["close-pools"]);
  });
});

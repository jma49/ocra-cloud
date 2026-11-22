import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { learningFile, parseLearning } from "../src/learning-file.js";
import type { LearningsView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { BLOB, HEAD, learningText, OTHER, platform } from "./learning-fakes.js";
import { connectGitlab, GITLAB, signInWithGithub } from "./platform-fakes.js";

// The same on GitLab, whose commits API makes the branch and guards the
// file by its last commit; and the file format the console reads and writes.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const API = `${GITLAB}/api/v4`;
const PROJECT = `${API}/projects/9`;
const POOLS = ".ocra/learnings/close-pools.md";
const FILE = `${PROJECT}/repository/files/${encodeURIComponent(POOLS)}?ref=${HEAD}`;
const b64 = (text: string) => btoa(text);

const head = {
  [`GET ${API}/projects/${encodeURIComponent("group/sub/project")}`]: () =>
    Response.json({ id: 9, path_with_namespace: "Group/Sub/Project", default_branch: "main" }),
  [`GET ${PROJECT}/repository/branches/main`]: () => Response.json({ commit: { id: HEAD } }),
};

const learning = {
  title: "Close every pool",
  paths: ["src/db/**"],
  created: "2026-10-01",
  body: "Pools leak when a handler throws.",
};

async function signedIn() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

const put = (a: Awaited<ReturnType<typeof signInWithGithub>>, body: unknown) =>
  a.send("/api/learnings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("learnings on GitLab", () => {
  it("lists the directory's files with their blob and last commit", async () => {
    platform({
      ...head,
      [`GET ${PROJECT}/repository/tree?path=${encodeURIComponent(".ocra/learnings")}&ref=${HEAD}&per_page=100&page=1`]:
        () => Response.json([{ id: BLOB, path: POOLS, type: "blob", mode: "100644" }]),
      [`GET ${FILE}`]: () =>
        Response.json({
          blob_id: BLOB,
          last_commit_id: OTHER,
          size: learningText().length,
          encoding: "base64",
          content: b64(learningText()),
        }),
    });
    const a = await signedIn();
    const res = await a.send("/api/learnings?platform=gitlab&repo=group/sub/project");
    const view = (await res.json()) as LearningsView;
    expect(view.repo).toBe("Group/Sub/Project");
    expect(view.learnings).toMatchObject([
      {
        id: "close-pools",
        blobId: BLOB,
        title: "Close every pool",
        lastCommit: { sha: OTHER, at: null },
      },
    ]);
  });

  it("commits an edit on a new branch at the commit read, guarded by the file's last commit", async () => {
    const sent = platform({
      ...head,
      [`GET ${FILE}`]: () => Response.json({ blob_id: BLOB, last_commit_id: OTHER }),
      [`POST ${PROJECT}/repository/commits`]: () => Response.json({}, { status: 201 }),
      [`POST ${PROJECT}/merge_requests`]: () =>
        Response.json(
          { iid: 4, web_url: `${GITLAB}/group/sub/project/-/merge_requests/4` },
          { status: 201 },
        ),
    });
    const a = await signedIn();
    const res = await put(a, {
      platform: "gitlab",
      repo: "group/sub/project",
      id: "close-pools",
      expected: BLOB,
      learning,
    });
    expect(await res.json()).toEqual({
      outcome: "done",
      path: POOLS,
      pull: { number: 4, url: `${GITLAB}/group/sub/project/-/merge_requests/4` },
    });
    const commit = sent[0]?.body as {
      branch: string;
      start_sha: string;
      actions: Record<string, string>[];
    };
    expect(commit.start_sha).toBe(HEAD);
    expect(commit.branch).toMatch(/^ocra\/learnings-/);
    expect(commit.actions[0]).toMatchObject({
      action: "update",
      file_path: POOLS,
      last_commit_id: OTHER,
    });
    expect(sent[1]?.body).toMatchObject({ source_branch: commit.branch, target_branch: "main" });
  });

  it("answers a conflict when GitLab refuses the commit for a file changed since", async () => {
    const sent = platform({
      ...head,
      [`GET ${FILE}`]: () => Response.json({ blob_id: BLOB, last_commit_id: OTHER }),
      [`POST ${PROJECT}/repository/commits`]: () =>
        Response.json({ message: "the file has changed" }, { status: 400 }),
    });
    const a = await signedIn();
    const res = await put(a, {
      platform: "gitlab",
      repo: "group/sub/project",
      id: "close-pools",
      expected: BLOB,
      learning,
    });
    expect(await res.json()).toMatchObject({ outcome: "conflict", pull: null });
    expect(sent.some((s) => s.url.endsWith("/merge_requests"))).toBe(false);
  });

  it("answers a conflict for an addition whose file exists already", async () => {
    const sent = platform({
      ...head,
      [`GET ${FILE}`]: () => Response.json({ blob_id: BLOB, last_commit_id: OTHER }),
    });
    const a = await signedIn();
    const res = await put(a, {
      platform: "gitlab",
      repo: "group/sub/project",
      id: "close-pools",
      expected: null,
      learning,
    });
    expect(await res.json()).toMatchObject({ outcome: "conflict" });
    expect(sent).toEqual([]);
  });
});

describe("a learning file", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("reads back as it was written", () => {
    const file = learningFile({
      frontmatter: {
        title: "Quote: a title with # and : in it",
        paths: ["src/**"],
        symbols: [],
        keywords: ["k"],
        critical: true,
        source: { kind: "manual" },
        created: "2026-11-01",
      },
      body: "Body.",
    });
    if (typeof file === "string") throw new Error(file);
    expect(parseLearning(file)).toEqual({
      frontmatter: {
        title: "Quote: a title with # and : in it",
        paths: ["src/**"],
        symbols: [],
        keywords: ["k"],
        critical: true,
        source: { kind: "manual" },
        created: "2026-11-01",
      },
      body: "Body.",
    });
  });

  it("is refused without frontmatter, with YAML aliases, or past its size", () => {
    expect(parseLearning(encode("just text"))).toMatch(/frontmatter block/);
    expect(
      parseLearning(encode("---\ntitle: &a x\npaths: [*a]\ncreated: 2026-01-01\n---\nbody")),
    ).toMatch(/not valid YAML/);
    expect(parseLearning(encode(learningText("t", "x".repeat(20_000))))).toMatch(/larger than/);
  });
});

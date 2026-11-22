import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfigView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { BLOB, HEAD, OTHER, platform } from "./learning-fakes.js";
import { connectGitlab, GITLAB, signInWithGithub } from "./platform-fakes.js";

// The same on GitLab, whose files API names the blob and the last commit,
// and whose commits API makes the branch and guards the file by that commit.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const API = `${GITLAB}/api/v4`;
const PROJECT = `${API}/projects/9`;
const CONFIG = ".ocra/config.json";
const FILE = `${PROJECT}/repository/files/${encodeURIComponent(CONFIG)}?ref=${HEAD}`;
const valid = '{ "exclude": ["dist/**"], "verify": true }\n';

const head = {
  [`GET ${API}/projects/${encodeURIComponent("group/sub/project")}`]: () =>
    Response.json({ id: 9, path_with_namespace: "Group/Sub/Project", default_branch: "main" }),
  [`GET ${PROJECT}/repository/branches/main`]: () => Response.json({ commit: { id: HEAD } }),
};
const file = (text: string) => () =>
  Response.json({
    blob_id: BLOB,
    last_commit_id: OTHER,
    size: new TextEncoder().encode(text).byteLength,
    encoding: "base64",
    content: btoa(text),
  });

async function signedIn() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

type Signed = Awaited<ReturnType<typeof signedIn>>;
const save = (a: Signed, body: Record<string, unknown>) =>
  a.send("/api/repo-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "gitlab", repo: "group/sub/project", ...body }),
  });

describe("a repository's configuration on GitLab", () => {
  it("reads the file at the default branch with its blob and last commit", async () => {
    platform({ ...head, [`GET ${FILE}`]: file(valid) });
    const a = await signedIn();
    const res = await a.send("/api/repo-config?platform=gitlab&repo=group/sub/project");
    expect((await res.json()) as RepoConfigView).toMatchObject({
      repo: "Group/Sub/Project",
      blobId: BLOB,
      text: valid,
      value: { exclude: ["dist/**"], verify: true },
      errors: [],
      lastCommit: { sha: OTHER, at: null },
    });
  });

  it("answers no blob for a project without the file", async () => {
    platform({ ...head, [`GET ${FILE}`]: () => Response.json({}, { status: 404 }) });
    const a = await signedIn();
    const res = await a.send("/api/repo-config?platform=gitlab&repo=group/sub/project");
    expect(await res.json()).toMatchObject({ blobId: null, text: null });
  });

  it("commits an edit on a new branch at the commit read, guarded by the file's last commit", async () => {
    const sent = platform({
      ...head,
      [`GET ${FILE}`]: file("{}"),
      [`POST ${PROJECT}/repository/commits`]: () => Response.json({}, { status: 201 }),
      [`POST ${PROJECT}/merge_requests`]: () =>
        Response.json(
          { iid: 3, web_url: `${GITLAB}/group/sub/project/-/merge_requests/3` },
          { status: 201 },
        ),
    });
    const a = await signedIn();
    const res = await save(a, { text: valid, expected: BLOB });
    expect(await res.json()).toEqual({
      outcome: "done",
      path: CONFIG,
      pull: { number: 3, url: `${GITLAB}/group/sub/project/-/merge_requests/3` },
    });
    const commit = sent[0]?.body as {
      branch: string;
      start_sha: string;
      actions: Record<string, string>[];
    };
    expect(commit.start_sha).toBe(HEAD);
    expect(commit.branch).toMatch(/^ocra\/config-\d{14}-[0-9a-f]{6}$/);
    expect(commit.actions[0]).toMatchObject({
      action: "update",
      file_path: CONFIG,
      last_commit_id: OTHER,
      content: btoa(valid),
    });
    expect(sent[1]?.body).toMatchObject({ source_branch: commit.branch, target_branch: "main" });
  });

  it("answers a conflict when GitLab refuses the commit for a file changed since", async () => {
    const sent = platform({
      ...head,
      [`GET ${FILE}`]: file("{}"),
      [`POST ${PROJECT}/repository/commits`]: () =>
        Response.json({ message: "the file has changed" }, { status: 400 }),
    });
    const a = await signedIn();
    const res = await save(a, { text: valid, expected: BLOB, direct: true });
    expect(await res.json()).toEqual({ outcome: "conflict", path: CONFIG, pull: null });
    expect(sent[0]?.body).toMatchObject({ branch: "main" });
    expect(sent.some((s) => s.url.endsWith("/merge_requests"))).toBe(false);
  });

  it("answers a conflict for an addition whose file exists already, writing nothing", async () => {
    const sent = platform({ ...head, [`GET ${FILE}`]: file("{}") });
    const a = await signedIn();
    const res = await save(a, { text: valid, expected: null });
    expect(await res.json()).toMatchObject({ outcome: "conflict" });
    expect(sent).toEqual([]);
  });

  it("refuses a file the engine would not read, writing nothing", async () => {
    const sent = platform({ ...head, [`GET ${FILE}`]: file("{}") });
    const a = await signedIn();
    const res = await save(a, { text: '{ "effort": { "top": "max" } }', expected: BLOB });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_body",
      issues: [{ path: ["text", "effort", "top"] }],
    });
    expect(sent).toEqual([]);
  });
});

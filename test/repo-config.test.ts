import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfigChangeView, RepoConfigView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { BLOB, githubBlobs, githubHead, HEAD, OTHER, platform } from "./learning-fakes.js";
import { signInWithGithub } from "./platform-fakes.js";

// A repository's committed review configuration on GitHub: read at the
// default branch and checked against the engine's schema, and an edit
// committed as the user on a new branch opened as a pull request, guarded
// by the blob read, and refused before any write when the engine would not
// read it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const REPO = "https://api.github.com/repos/octo/api";
const CONFIG = ".ocra/config.json";
const FILE = `${REPO}/contents/.ocra/config.json`;
const SCHEMA_ID = "https://ocra.majincheng.com/schema/config.v1.json";
const valid = `{\n  "$schema": "${SCHEMA_ID}",\n  "models": { "top": "openai/gpt-5" },\n  "concurrency": 4\n}\n`;

type Signed = Awaited<ReturnType<typeof signInWithGithub>>;
const read = (a: Signed, query = "") =>
  a.send(`/api/repo-config?platform=github&repo=octo/api${query}`);
const save = (a: Signed, body: Record<string, unknown>) =>
  a.send("/api/repo-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "github", repo: "octo/api", ...body }),
  });

describe("reading a repository's configuration", () => {
  it("answers the file at the default branch, parsed, with its blob and the schema's id", async () => {
    platform(githubHead, githubBlobs({ [CONFIG]: { oid: BLOB, text: valid } }));
    const a = await signInWithGithub();
    const res = await read(a);
    expect(res.status).toBe(200);
    expect((await res.json()) as RepoConfigView).toEqual({
      platform: "github",
      repo: "octo/api",
      branch: "main",
      commit: HEAD,
      file: "config",
      path: CONFIG,
      blobId: BLOB,
      text: valid,
      value: JSON.parse(valid),
      parseError: null,
      errors: [],
      moreErrors: false,
      refusal: null,
      schema: SCHEMA_ID,
      lastCommit: { sha: OTHER, at: "2026-11-01T00:00:00Z" },
    });
  });

  it("names what the engine would refuse, and a file that is not JSON", async () => {
    platform(
      githubHead,
      githubBlobs({ [CONFIG]: { oid: BLOB, text: '{ "concurrency": 99, "bogus": true }' } }),
    );
    const a = await signInWithGithub();
    const view = (await (await read(a)).json()) as RepoConfigView;
    expect(view.value).toEqual({ concurrency: 99, bogus: true });
    expect(view.errors.map((e) => e.path)).toEqual(expect.arrayContaining([["concurrency"]]));
    expect(view.errors.some((e) => /bogus/.test(e.message))).toBe(true);

    vi.restoreAllMocks();
    platform(githubHead, githubBlobs({ [CONFIG]: { oid: BLOB, text: "{ nope" } }));
    const broken = (await (await read(a)).json()) as RepoConfigView;
    expect(broken).toMatchObject({ text: "{ nope", value: null, errors: [] });
    expect(broken.parseError).toMatch(/not valid JSON/);
  });

  it("refuses what the CLI's own checks refuse, worded as the CLI words it", async () => {
    // Each fits the configuration's JSON Schema; only the contract's refinements refuse them.
    const provider = { type: "openai-compatible", models: { m: { input: 1, output: 2 } } };
    const text = JSON.stringify({
      providers: {
        braces: { ...provider, baseUrl: "https://api.example/{env:HOME}/v1" },
        token: { ...provider, baseUrl: "https://api.example/v1", apiKeyEnv: "GITHUB_TOKEN" },
      },
    });
    platform(githubHead, githubBlobs({ [CONFIG]: { oid: BLOB, text } }));
    const a = await signInWithGithub();
    const view = (await (await read(a)).json()) as RepoConfigView;
    expect(view.errors).toEqual([
      { path: ["providers", "braces", "baseUrl"], message: "must not contain { or }" },
      {
        path: ["providers", "token", "apiKeyEnv"],
        message: "must not name a platform or cloud credential",
      },
    ]);
    expect(view.refusal).toBe(
      "✖ must not contain { or }\n  → at providers.braces.baseUrl\n" +
        "✖ must not name a platform or cloud credential\n  → at providers.token.apiKeyEnv",
    );

    const res = await save(a, { text, expected: BLOB });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_body",
      issues: [
        { path: ["text", "providers", "braces", "baseUrl"] },
        { path: ["text", "providers", "token", "apiKeyEnv"] },
      ],
      refusal: view.refusal,
    });

    const notUrl = JSON.stringify({ providers: { x: { ...provider, baseUrl: "not a url" } } });
    const refused = await save(a, { text: notUrl, expected: BLOB });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "invalid_body",
      issues: [{ path: ["text", "providers", "x", "baseUrl"] }],
    });
  });

  it("answers no blob for a repository without the file", async () => {
    platform(githubHead, githubBlobs({}));
    const a = await signInWithGithub();
    const view = (await (await read(a)).json()) as RepoConfigView;
    expect(view).toMatchObject({ blobId: null, text: null, value: null, parseError: null });
  });

  it("reads the rules file against the engine's rule schema, which has no JSON Schema", async () => {
    platform(
      githubHead,
      githubBlobs({
        ".ocra/rules.json": { oid: BLOB, text: '{ "rules": [{ "path": "src/**" }] }' },
      }),
    );
    const a = await signInWithGithub();
    const view = (await (await read(a, "&file=rules")).json()) as RepoConfigView;
    expect(view).toMatchObject({ file: "rules", path: ".ocra/rules.json", schema: null });
    expect(view.errors.map((e) => e.path)).toEqual([["rules", 0, "rule"]]);
  });

  it("reads the rules in plain language as text, which only a length limit refuses", async () => {
    const rules = "## services/billing/\n\nEvery handler checks the caller's account.\n";
    platform(githubHead, githubBlobs({ ".ocra/rules.md": { oid: BLOB, text: rules } }));
    const a = await signInWithGithub();
    const view = (await (await read(a, "&file=rulesMarkdown")).json()) as RepoConfigView;
    expect(view).toMatchObject({
      file: "rulesMarkdown",
      path: ".ocra/rules.md",
      schema: null,
      text: rules,
      value: null,
      parseError: null,
      errors: [],
    });
  });

  it("answers not found for another file, or a repository the user does not reach", async () => {
    platform({});
    const a = await signInWithGithub();
    expect((await read(a, "&file=../../etc")).status).toBe(404);
    expect((await read(a)).status).toBe(404);
  });
});

describe("changing a repository's configuration on GitHub", () => {
  it("commits the text on a new branch from the head it read, and opens a pull request", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: BLOB }),
      [`POST ${REPO}/git/refs`]: () => Response.json({}, { status: 201 }),
      [`PUT ${FILE}`]: () => Response.json({}, { status: 200 }),
      [`POST ${REPO}/pulls`]: () =>
        Response.json(
          { number: 7, html_url: "https://github.com/octo/api/pull/7" },
          { status: 201 },
        ),
    });
    const a = await signInWithGithub();
    const res = await save(a, { text: valid, expected: BLOB });
    expect((await res.json()) as RepoConfigChangeView).toEqual({
      outcome: "done",
      path: CONFIG,
      pull: { number: 7, url: "https://github.com/octo/api/pull/7" },
    });
    const [ref, put, pull] = sent as { body: Record<string, string> }[];
    expect(ref?.body.ref).toMatch(/^refs\/heads\/ocra\/config-\d{14}-[0-9a-f]{6}$/);
    expect(ref?.body.sha).toBe(HEAD);
    const branch = ref?.body.ref?.slice("refs/heads/".length);
    expect(put?.body).toMatchObject({
      branch,
      sha: BLOB,
      message: `chore(ocra): update ${CONFIG}`,
    });
    expect(
      new TextDecoder().decode(
        Uint8Array.from(atob(put?.body.content ?? ""), (c) => c.charCodeAt(0)),
      ),
    ).toBe(valid);
    expect(pull?.body).toMatchObject({ head: branch, base: "main" });
  });

  it("answers a conflict, writing nothing, when the file is not the blob the edit was made on", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => Response.json({ type: "file", sha: OTHER }),
    });
    const a = await signInWithGithub();
    const res = await save(a, { text: valid, expected: BLOB });
    expect(await res.json()).toEqual({ outcome: "conflict", path: CONFIG, pull: null });
    expect(sent).toEqual([]);
  });

  it("adds the file on the default branch when asked; an existing one answers a conflict", async () => {
    const sent = platform({
      ...githubHead,
      [`GET ${FILE}?ref=${HEAD}`]: () => new Response(null, { status: 404 }),
      [`PUT ${FILE}`]: () => Response.json({}, { status: 201 }),
    });
    const a = await signInWithGithub();
    const res = await save(a, { text: valid, expected: null, direct: true });
    expect(await res.json()).toEqual({ outcome: "done", path: CONFIG, pull: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ branch: "main", message: `chore(ocra): add ${CONFIG}` });
    expect(sent[0]?.body).not.toHaveProperty("sha");
  });

  it("refuses a file the engine would not read, with its issues, before calling the platform", async () => {
    platform({});
    const fetched = vi.mocked(globalThis.fetch);
    const a = await signInWithGithub();
    const calls = fetched.mock.calls.length;
    const res = await save(a, { text: '{ "concurrency": 0, "plugins": "x" }', expected: BLOB });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: unknown[] }[] };
    expect(body.error).toBe("invalid_body");
    expect(body.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        ["text", "concurrency"],
        ["text", "plugins"],
      ]),
    );
    const notJson = await save(a, { text: "{", expected: BLOB });
    expect(await notJson.json()).toMatchObject({
      error: "invalid_body",
      issues: [{ path: ["text"], message: expect.stringMatching(/not valid JSON/) }],
    });
    const badRules = await save(a, { file: "rules", text: '{ "rules": {} }', expected: BLOB });
    expect(badRules.status).toBe(400);
    const longRules = await save(a, {
      file: "rulesMarkdown",
      text: "x".repeat(20_001),
      expected: BLOB,
    });
    expect(await longRules.json()).toMatchObject({
      error: "invalid_body",
      issues: [{ path: ["text"], message: ".ocra/rules.md is longer than 20000 characters" }],
    });
    expect(fetched.mock.calls.length).toBe(calls);
  });
});

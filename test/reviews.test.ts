import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUpload } from "../src/reviews.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const json = { "content-type": "application/json" };
const HASH = "a".repeat(64);
const upload = (over: Record<string, unknown> = {}) => ({
  runId: "20261004T055558Z-e60b25",
  repoHash: HASH,
  source: "local",
  tier: "lite",
  verdict: "approved_with_comments",
  complete: false,
  findings: { critical: 0, warning: 1, suggestion: 2 },
  files: { reviewed: 3, notReviewed: 1 },
  tasks: { completed: 1, failed: 0 },
  usage: { inputTokens: 3047, outputTokens: 1903, costUsd: 0 },
  durationMs: 26100,
  ocraVersion: "0.4.0",
  ...over,
});

describe("review uploads", () => {
  it("stores counts from a CLI session once per run, and the web lists them", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const post = () =>
      call("/api/reviews", {
        method: "POST",
        headers: { ...cli.auth, ...json },
        body: JSON.stringify(upload()),
      });
    const first = (await (await post()).json()) as { id: string };
    expect(first.id).toBeTruthy();
    expect(await (await post()).json()).toEqual({ id: first.id, duplicate: true });

    const list = (await (await call("/api/reviews", { headers: web.auth })).json()) as {
      summary: Record<string, number>;
      reviews: Record<string, unknown>[];
    };
    expect(list.summary).toMatchObject({ reviews: 1, repositories: 1, findings: 3, incomplete: 1 });
    expect(list.reviews[0]).toMatchObject({
      verdict: "approved_with_comments",
      warning: 1,
      repo: "aaaaaaaa",
    });
    expect(JSON.stringify(list)).not.toContain("accountId");
    // The CLI uploads but cannot read the history.
    expect((await call("/api/reviews", { headers: cli.auth })).status).toBe(403);
  });

  it("keeps only the known fields and refuses a malformed upload", () => {
    const row = parseUpload(
      upload({ title: "secret title", findings: { critical: 1, body: "code" }, path: "src/x" }),
    );
    expect(JSON.stringify(row)).not.toMatch(/secret title|code|src\/x/);
    expect(parseUpload(upload({ repoHash: "my-org/my-repo" }))).toBeUndefined();
    expect(parseUpload(upload({ runId: "../../x" }))).toBeUndefined();
    expect(parseUpload(upload({ source: "bitbucket" }))).toBeUndefined();
    expect(parseUpload(upload({ verdict: "lgtm" }))?.verdict).toBeNull();
    expect(parseUpload(upload({ findings: { warning: -5 } }))?.warning).toBe(0);
  });

  it("each account sees only its own reviews", async () => {
    const a = await signInCli(1, "a");
    const b = await signIn(2, "b");
    await call("/api/reviews", {
      method: "POST",
      headers: { ...a.auth, ...json },
      body: JSON.stringify(upload()),
    });
    const list = (await (await call("/api/reviews", { headers: b.auth })).json()) as {
      reviews: unknown[];
    };
    expect(list.reviews).toEqual([]);
  });
});

describe("default models", () => {
  it("are set on the web and read by the CLI", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const put = (body: unknown, auth = web.auth) =>
      call("/api/preferences/models", {
        method: "PUT",
        headers: { ...auth, ...json },
        body: JSON.stringify(body),
      });
    expect(
      (await put({ standard: ["ocra-openrouter/qwen/qwen3.8-27b:free"], light: "" })).status,
    ).toBe(200);
    expect((await put({ top: ["anthropic/claude"] })).status).toBe(400);
    expect(
      (await put({ top: ["ocra-a/1", "ocra-a/2", "ocra-a/3", "ocra-a/4", "ocra-a/5"] })).status,
    ).toBe(400);
    expect((await put({ standard: ["ocra-x/y"] }, cli.auth)).status).toBe(403);
    const read = await call("/api/preferences/models", { headers: cli.auth });
    expect(await read.json()).toEqual({
      models: { standard: ["ocra-openrouter/qwen/qwen3.8-27b:free"] },
    });
  });
});

describe("model lists", () => {
  it("lists the provider's models with the stored key", async () => {
    const web = await signIn(1, "octo");
    vi.spyOn(globalThis, "fetch")
      .mockClear()
      .mockImplementation(async () => Response.json({}));
    await call("/api/keys/gemini", {
      method: "PUT",
      headers: { ...web.auth, ...json },
      body: JSON.stringify({ key: "AIza-0123456789" }),
    });
    const fake = vi
      .spyOn(globalThis, "fetch")
      .mockClear()
      .mockImplementation(async () =>
        Response.json({
          models: [
            { name: "models/gemini-3.5-flash" },
            { name: "models/gemini-3.1-pro" },
            { name: "bad name!" },
          ],
        }),
      );
    const res = await call("/api/keys/gemini/models", { headers: web.auth });
    expect(await res.json()).toEqual({
      provider: "gemini",
      models: ["gemini-3.1-pro", "gemini-3.5-flash"],
    });
    expect(new Headers(fake.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe(
      "AIza-0123456789",
    );
  });
});

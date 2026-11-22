import { generateKeyPairSync } from "node:crypto";
import { parseGraph } from "@open-cr-agent/code-graph";
import { describe, expect, it } from "vitest";
import { engineGraphBuilder } from "../src/node/engine-graph.js";
import { autoReviewSettingsFrom, graphSettingsFrom } from "../src/node/env.js";

// The engine's builder as the server calls it: a real tree-sitter parse, then
// an update that reads only the changed blob.

const files: Record<string, string> = {
  a1: "export function total(xs: number[]) {\n  return xs.length;\n}\n",
  b1: 'import { total } from "./a";\nexport const n = total([1, 2]);\n',
  b2: 'import { total } from "./a";\nexport const n = total([1, 2, 3]);\n',
};

const build = (previous: string | undefined, tree: { path: string; blobId: string }[]) => {
  const read: string[] = [];
  const done = engineGraphBuilder({
    previous,
    tree,
    readBlob: async (blobId) => {
      read.push(blobId);
      return new TextEncoder().encode(files[blobId]);
    },
    revision: "r",
    maxBlobBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  return done.then((out) => ({ ...out, read }));
};

describe("the engine's graph builder", () => {
  it("parses a commit, then reads only what the next one changed", async () => {
    const first = await build(undefined, [
      { path: "a.ts", blobId: "a1" },
      { path: "b.ts", blobId: "b1" },
      { path: "README.md", blobId: "readme" },
    ]);
    expect(first).toMatchObject({ files: 2, parsed: 2, reused: 0, skipped: 0 });
    expect(parseGraph(first.graph)?.files.get("a.ts")).toBe("typescript:a1");

    const second = await build(first.graph, [
      { path: "a.ts", blobId: "a1" },
      { path: "b.ts", blobId: "b2" },
    ]);
    expect(second).toMatchObject({ files: 2, parsed: 1, reused: 1 });
    expect(second.read).toEqual(["b2"]);
  });

  it("rebuilds from scratch when the previous graph is not one it reads", async () => {
    const out = await build("{}", [{ path: "a.ts", blobId: "a1" }]);
    expect(out).toMatchObject({ parsed: 1, reused: 0 });
  });
});

describe("the graph settings", () => {
  it("keep graphs with one worker by default, and refuse a bad worker count", () => {
    expect(graphSettingsFrom({})).toEqual({ policy: "keep", workers: 1 });
    expect(graphSettingsFrom({ GRAPH_WORKERS: "3" })).toMatchObject({ workers: 3 });
    expect(() => graphSettingsFrom({ GRAPH_WORKERS: "0" })).toThrow("GRAPH_WORKERS");
  });
});

describe("the auto review settings", () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();

  it("are off without a bot, take one worker by default, and refuse a bad count", () => {
    expect(autoReviewSettingsFrom({})).toBeUndefined();
    expect(autoReviewSettingsFrom({ GITLAB_BOT_TOKEN: "t" })).toMatchObject({ workers: 1 });
    const one = autoReviewSettingsFrom({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: key.replaceAll("\n", "\\n"),
      AUTO_REVIEW_WORKERS: "0",
    });
    expect(one).toMatchObject({ workers: 0, bots: { githubAppPrivateKey: key } });
    expect(() =>
      autoReviewSettingsFrom({ GITLAB_BOT_TOKEN: "t", AUTO_REVIEW_WORKERS: "x" }),
    ).toThrow("AUTO_REVIEW_WORKERS");
  });

  it("refuse a GitHub App that would fail its first review", () => {
    expect(() => autoReviewSettingsFrom({ GITHUB_APP_ID: "1" })).toThrow(
      "needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
    );
    expect(() =>
      autoReviewSettingsFrom({ GITHUB_APP_ID: "ocra-bot", GITHUB_APP_PRIVATE_KEY: key }),
    ).toThrow("GITHUB_APP_ID must be the App's number");
    expect(() =>
      autoReviewSettingsFrom({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "-----BEGIN\\nKEY" }),
    ).toThrow("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  });
});

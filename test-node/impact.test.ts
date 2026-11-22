import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { engineGraphBuilder } from "../src/node/engine-graph.js";
import { gitlabChanges } from "../src/platforms/gitlab-changes.js";
import type { ImpactView } from "../src/shared/index.js";
import { C1, C2, type FakePull, fakeBuilder, GITLAB, repoFake } from "./graph-fakes.js";
import { addRepo, graphServer, type Server } from "./graph-server.js";

// A pull request's impact as the console asks for it: the platform's hunks
// against the server's graph, built here by the engine's real parser.

const parse = [
  "export function parseAmount(input: string): number {",
  '  const clean = input.replace(/[^0-9.]/g, "");',
  "  return Number.parseFloat(clean);",
  "}",
].join("\n");
const limits = [
  "const MAX_REFUND = 500;",
  'import { parseAmount } from "./parse";',
  "export function refundCap(input: string): boolean {",
  "  if (parseAmount(input) > MAX_REFUND) {",
  "    return false;",
  "  }",
  "  return true;",
  "}",
].join("\n");
const total = [
  'import { parseAmount } from "./parse";',
  "export function cartTotal(xs: string[]): number {",
  "  return xs.reduce((sum, x) => sum + parseAmount(x), 0);",
  "}",
].join("\n");
const BASE = { "src/parse.ts": parse, "src/limits.ts": limits, "src/total.ts": total };

const pull: FakePull = {
  base: C1,
  head: C2,
  files: [
    { path: "src/parse.ts", status: "modified", patch: "@@ -3,1 +3,1 @@\n-x\n+y" },
    { path: "src/total.ts", status: "modified", patch: "@@ -3,1 +3,1 @@\n-x\n+y" },
  ],
};

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-impact-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe("a pull request's impact", () => {
  let s: Server;
  beforeEach(async () => {
    s = await graphServer(dir, `impact-${n++}.db`, "keep", {
      builder: engineGraphBuilder,
      calls: [],
    });
  });
  afterEach(async () => {
    await s.settled();
    s.host.close();
  });

  async function added(pulls: Record<number, FakePull>, head = C1) {
    const fake = repoFake({ [C1]: BASE }, head, pulls);
    const user = await s.signIn(1);
    const res = await addRepo(s, user.auth, { platform: "github", fullName: "octo/api" });
    const { repo } = (await res.json()) as { repo: { id: string } };
    await s.settled();
    const impact = (number: string | number, auth = user.auth) =>
      s.call(`/api/graphs/repos/${repo.id}/impact?pull=${number}`, { headers: auth });
    return { fake, user, repo, impact };
  }

  it("names the changed symbol and its uses outside the pull request, with their code lines", async () => {
    const { impact } = await added({ 482: pull });
    const res = await impact(482);
    expect(res.status).toBe(200);
    const view = (await res.json()) as ImpactView;
    expect(view.pull).toEqual({ base: C1, head: C2, files: 2, truncated: false, unread: 0 });
    expect(view.graph).toMatchObject({ commit: C1, current: true, truncated: false, files: 3 });
    expect(view.build).toBeNull();
    const amount = view.symbols.find((x) => x.name === "parseAmount");
    expect(amount).toMatchObject({
      kind: "function",
      path: "src/parse.ts",
      startLine: 1,
      change: "body",
      lines: [[3, 3]],
      useCount: 2,
      fileCount: 1,
    });
    expect(amount?.uses).toEqual([
      { path: "src/limits.ts", line: 2, within: null, code: limits.split("\n")[1] },
      { path: "src/limits.ts", line: 4, within: "refundCap", code: limits.split("\n")[3] },
    ]);
    expect(view.symbols.map((x) => x.name)).toContain("cartTotal");
  });

  it("says when its graph is not of the pull request's base", async () => {
    const { impact } = await added({ 7: { ...pull, base: C2, head: "4".repeat(40) } });
    const view = (await (await impact(7)).json()) as ImpactView;
    expect(view.graph).toMatchObject({ commit: C1, current: false });
  });

  it("is refused for a pull request the account does not reach, a bad number, or another account's graph", async () => {
    const { impact } = await added({ 482: pull });
    expect((await impact(999)).status).toBe(404);
    expect((await impact("1e3x")).status).toBe(404);
    expect((await impact(0)).status).toBe(404);
    const other = await s.signIn(2);
    expect((await impact(482, other.auth)).status).toBe(404);
  });
});

describe("a GitLab merge request's changes", () => {
  it("are read with their hunks, renames on the old path, and no diff where GitLab collapsed one", async () => {
    repoFake({}, C1, {
      9: {
        base: C1,
        head: C2,
        files: [
          { path: "lib/b.ts", oldPath: "lib/a.ts", status: "renamed" },
          { path: "lib/c.ts", status: "modified", patch: "@@ -4,2 +4,3 @@\n x" },
          { path: "lib/big.ts", status: "modified" },
        ],
      },
    });
    const changes = await gitlabChanges(GITLAB).changes("glpat_1", "group/api", 9);
    expect(changes).toEqual({
      title: null,
      author: null,
      url: null,
      base: C1,
      head: C2,
      updatedAt: null,
      truncated: false,
      files: [
        { path: "lib/b.ts", oldPath: "lib/a.ts", status: "renamed", hunks: [] },
        {
          path: "lib/c.ts",
          oldPath: "lib/c.ts",
          status: "modified",
          hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 3 }],
        },
        { path: "lib/big.ts", oldPath: "lib/big.ts", status: "modified", hunks: null },
      ],
    });
  });
});

describe("a pull request's impact before any graph is built", () => {
  it("has no graph and names the failed build", async () => {
    const s = await graphServer(dir, `impact-${n++}.db`, "keep", fakeBuilder({ fail: true }));
    repoFake({ [C1]: BASE }, C1, { 482: pull });
    const user = await s.signIn(1);
    const res = await addRepo(s, user.auth, { platform: "github", fullName: "octo/api" });
    const { repo } = (await res.json()) as { repo: { id: string } };
    await s.settled();
    const view = (await (
      await s.call(`/api/graphs/repos/${repo.id}/impact?pull=482`, { headers: user.auth })
    ).json()) as ImpactView;
    expect(view).toMatchObject({ graph: null, build: { commit: C1 }, symbols: [], more: 0 });
    expect(["queued", "failed"]).toContain(view.build?.state);
    s.host.close();
  });
});

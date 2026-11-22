import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { graphBuilds } from "../src/db/schema.js";
import type { GraphPolicy } from "../src/shared/index.js";
import { C1, C2, fakeBuilder, repoFake } from "./graph-fakes.js";
import { addRepo, graphServer, type Server } from "./graph-server.js";

// What the console's code graph page relies on: whether the server keeps
// graphs, and rebuilding a repository's graph on demand.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-graph-console-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

async function withServer(
  policy: GraphPolicy,
  test: (s: Server) => Promise<void>,
  builder = fakeBuilder(),
) {
  const s = await graphServer(dir, `console-${n++}.db`, policy, builder);
  try {
    await test(s);
  } finally {
    await s.settled();
    s.host.close();
  }
}

const rebuild = (s: Server, auth: Record<string, string>, id: string) =>
  s.call(`/api/graphs/repos/${id}/builds`, { method: "POST", headers: auth });

async function added(s: Server, auth: Record<string, string>) {
  const res = await addRepo(s, auth, { platform: "github", fullName: "octo/api" });
  return ((await res.json()) as { repo: { id: string } }).repo.id;
}

describe("/me", () => {
  it.each(["keep", "opt-in", "off"] as const)("says the server's policy: %s", (policy) =>
    withServer(policy, async (s) => {
      const { auth } = await s.signIn(1);
      expect(await (await s.call("/api/me", { headers: auth })).json()).toMatchObject({
        codeGraphs: policy,
      });
    }),
  );
});

describe("rebuilding a code graph", () => {
  it("builds a failed head again, with its attempts started over", () => {
    const failing = fakeBuilder({ fail: true });
    return withServer(
      "keep",
      async (s) => {
        repoFake({ [C1]: { "a.ts": "a" } });
        const { account, auth } = await s.signIn(1);
        const id = await added(s, auth);
        await s.settled();
        await s.host.db.update(graphBuilds).set({
          state: "failed",
          error: "build_failed",
          attempts: 3,
        });
        const res = await rebuild(s, auth, id);
        expect(await res.json()).toMatchObject({
          queued: true,
          repo: { id, latest: { commit: C1, state: "queued", error: null } },
        });
        await s.settled();
        expect(await s.builds(account.id)).toMatchObject([
          { commit: C1, state: "queued", attempts: 1, error: "build_failed" },
        ]);
      },
      failing,
    );
  });

  it("queues the branch's new head, and builds a finished head again in place", () =>
    withServer("keep", async (s) => {
      repoFake({ [C1]: { "a.ts": "a" } });
      const { account, auth } = await s.signIn(1);
      const id = await added(s, auth);
      await s.settled();
      vi.restoreAllMocks();
      repoFake({ [C1]: { "a.ts": "a" }, [C2]: { "a.ts": "b" } }, C2);
      expect(await (await rebuild(s, auth, id)).json()).toMatchObject({ queued: true });
      await s.settled();
      expect(await s.builds(account.id)).toMatchObject([
        { commit: C1, state: "done" },
        { commit: C2, state: "done" },
      ]);

      const [, done] = await s.builds(account.id);
      expect(await (await rebuild(s, auth, id)).json()).toMatchObject({ queued: true });
      await s.settled();
      const [, again] = await s.builds(account.id);
      expect(again).toMatchObject({ id: done?.id, state: "done" });
    }));

  it("is refused for another account's repository, and where the server keeps none", async () => {
    await withServer("keep", async (s) => {
      repoFake({ [C1]: { "a.ts": "a" } });
      const { auth } = await s.signIn(1);
      const id = await added(s, auth);
      const other = await s.signIn(2);
      expect((await rebuild(s, other.auth, id)).status).toBe(404);
      expect((await rebuild(s, auth, "no-such-repo")).status).toBe(404);
    });
    await withServer("off", async (s) => {
      const { auth } = await s.signIn(1);
      expect((await rebuild(s, auth, "any")).status).toBe(404);
    });
  });
});

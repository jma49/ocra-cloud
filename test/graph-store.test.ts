import { beforeEach, describe, expect, it } from "vitest";
import { claimBuild } from "../src/db/graphs.js";
import { scoped } from "../src/db/scoped.js";
import { db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

beforeEach(resetDb);

const now = new Date("2026-11-23T09:00:00Z");
const LEASE = 60_000;
const COMMIT = "a".repeat(40);

/** Gzipped bytes do not compress, and neither does this: three pieces of base64. */
function content(bytes: number): { base64: string; raw: Uint8Array } {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65_536) crypto.getRandomValues(raw.subarray(i, i + 65_536));
  return { base64: Buffer.from(raw).toString("base64"), raw };
}

const built = (base64: string) => ({
  content: base64,
  files: 3,
  parsed: 3,
  reused: 0,
  skipped: 0,
  truncated: false,
});

async function claimed(login: string) {
  const { account } = await signIn(1, login);
  const data = scoped(db, account.id);
  const repo = { id: await data.insert("graphRepos", rows.graphRepos("r")) };
  await data.graphs.queueBuild(repo.id, COMMIT);
  const build = await claimBuild(db, now, LEASE);
  if (!build) throw new Error("no build to claim");
  return { data, repo, build };
}

describe("a stored graph", () => {
  it("is read back whole from the pieces it was kept in", async () => {
    const { data, repo, build } = await claimed("octo");
    const graph = content(2_000_000);

    expect(await data.graphs.finishBuild(build.id, build.attempts, built(graph.base64), now)).toBe(
      true,
    );

    expect(await data.count("graphChunks")).toBe(3);
    const stored = await data.graphs.newestGraph(repo.id);
    expect(stored?.commit).toBe(COMMIT);
    expect(stored?.content.length).toBe(graph.raw.length);
    expect(Buffer.from(stored?.content ?? []).equals(Buffer.from(graph.raw))).toBe(true);
    const [summary] = await data.graphs.latestBuilds();
    expect(summary).toMatchObject({ state: "done", bytes: 2_000_000, files: 3 });
  });

  it("is not kept from a run whose claim another run took over", async () => {
    const { data, repo, build } = await claimed("octo");

    const kept = await data.graphs.finishBuild(
      build.id,
      build.attempts - 1,
      built(content(1_000).base64),
      now,
    );

    expect(kept).toBe(false);
    expect(await data.count("graphChunks")).toBe(0);
    expect(await data.graphs.newestGraph(repo.id)).toBeUndefined();
  });
});

describe("a pull request's kept impact", () => {
  it("is the newest one kept", async () => {
    const { data, repo } = await claimed("octo");

    await data.graphs.keepImpact(repo.id, 7, "b".repeat(40), '{"more":1}', now);
    await data.graphs.keepImpact(repo.id, 7, "c".repeat(40), '{"more":2}', new Date(+now + 1000));

    expect(await data.graphs.keptImpact(repo.id, 7)).toBe('{"more":2}');
    expect(await data.graphs.keptImpact(repo.id, 8)).toBeUndefined();
    expect(await data.count("pullImpacts")).toBe(1);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, repoFake } from "./graph-fakes.js";
import { graphServer, type Server } from "./graph-server.js";

// Tests or docstrings asked for on a pull request of an enrolled repository:
// queued once per head and kind, for the enrolling account only.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-generate-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
beforeEach(async () => {
  s = await graphServer(dir, `generate-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    workers: 0,
  });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "Octo/API", number: 7 };
const listed = `/api/auto-review/generate?platform=github&repo=Octo/API&number=7`;

const ask = (auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/auto-review/generate", { method: "POST", headers: auth, json });

describe("generating on a pull request", () => {
  it("queues each kind once per head and lists them for the pull request", async () => {
    const { auth } = await s.signIn(1);
    await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: auth,
      json: { platform: "github", fullName: "octo/api" },
    });
    const first = await ask(auth, { ...pull, head: HEAD, kind: "tests" });
    const again = await ask(auth, { ...pull, head: HEAD, kind: "tests" });
    const docs = await ask(auth, { ...pull, head: HEAD, kind: "docstrings" });
    expect([await first.json(), await again.json(), await docs.json()]).toEqual([
      { queued: true },
      { queued: false },
      { queued: true },
    ]);
    const view = await (await s.call(listed, { headers: auth })).json();
    expect(view).toMatchObject({ enrolled: true });
    expect(
      (view as { jobs: { kind: string; state: string }[] }).jobs.map((j) => j.kind).sort(),
    ).toEqual(["docstrings", "tests"]);
  });

  it("is refused on a repository the account did not enroll", async () => {
    const owner = await s.signIn(1);
    await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: owner.auth,
      json: { platform: "github", fullName: "octo/api" },
    });
    const other = await s.signIn(2);
    const res = await ask(other.auth, { ...pull, head: HEAD, kind: "tests" });
    expect(res.status).toBe(404);
    expect(await (await s.call(listed, { headers: other.auth })).json()).toEqual({
      enrolled: false,
      jobs: [],
    });
  });

  it("refuses a kind it does not write", async () => {
    const { auth } = await s.signIn(1);
    const res = await ask(auth, { ...pull, head: HEAD, kind: "changelog" });
    expect(res.status).toBe(400);
  });
});

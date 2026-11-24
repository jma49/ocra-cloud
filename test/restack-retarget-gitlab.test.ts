import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { db, resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";
import { gitlabHook, history, turn } from "./restack-fakes.js";
import { mergeOf, sha } from "./stack-fakes.js";
import { rows } from "./table-rows.js";

// GitLab moves the merge requests stacked on a merged one itself when it
// deletes the merged source branch, sometimes before the merge's hook is
// handled, which then finds none to move: each move's own update hook
// (changes.target_branch) queues the restack, under the merge's key, so the
// two never queue it twice. Its hooks arrive at the server's own address.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const FULL_NAME = "Group/Sub/Project";
const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent(FULL_NAME)}`;
const SECRET = "s".repeat(32);

type Mr = { iid: number; source: string; target: string; state: "opened" | "merged"; at?: Date };

/** A GitLab project whose merge requests move as the writes sent to it say. */
function gitlab(mrs: Mr[]) {
  const byIid = new Map(mrs.map((m) => [m.iid, m]));
  const moved: number[] = [];
  const api = (m: Mr) => ({
    iid: m.iid,
    title: `Step ${m.iid}`,
    web_url: `${GITLAB}/${FULL_NAME}/-/merge_requests/${m.iid}`,
    state: m.state,
    sha: sha(m.iid),
    source_branch: m.source,
    target_branch: m.target,
    source_project_id: 9,
    target_project_id: 9,
    squash_commit_sha: m.state === "merged" ? mergeOf(m.iid) : null,
    merged_at: m.state === "merged" ? (m.at ?? new Date()).toISOString() : null,
    detailed_merge_status: "mergeable",
  });
  githubFake({
    extra: async (req) => {
      const url = new URL(req.url);
      const path = `${url.origin}${url.pathname}`;
      if (!path.startsWith(PROJECT)) return undefined;
      if (req.method === "GET" && path === `${PROJECT}/merge_requests`) {
        const source = url.searchParams.get("source_branch");
        if (source && url.searchParams.get("state") === "all") {
          return Response.json([...byIid.values()].filter((m) => m.source === source).map(api));
        }
        const target = url.searchParams.get("target_branch");
        const open = [...byIid.values()].filter((m) => m.state === "opened" && m.target === target);
        return Response.json(open.map(api));
      }
      const one = path.match(/\/merge_requests\/(\d+)$/);
      const m = one ? byIid.get(Number(one[1])) : undefined;
      if (!m) return Response.json({}, { status: 404 });
      if (req.method === "GET") return Response.json(api(m));
      if (req.method === "PUT") {
        m.target = String(((await req.json()) as { target_branch: string }).target_branch);
        moved.push(m.iid);
        return Response.json(api(m));
      }
      return undefined;
    },
  });
  return { mrs: byIid, moved };
}

/** The project enrolled with its hook's secret, linked to GitLab, and the restack switch as given. */
async function enrolled(restack: boolean) {
  const a = await signInWithGithub();
  expect((await (await connectGitlab(a))("code=c&state=STATE")).status).toBe(302);
  const [account] = await db.select().from(schema.accounts);
  const data = scoped(db, account?.id ?? "");
  await data.insert("reviewRepos", {
    ...rows.reviewRepos("r"),
    platform: "gitlab" as const,
    host: new URL(GITLAB).host,
    platformRepoId: "9",
    fullName: FULL_NAME,
    webhookSecretHash: await sha256Hex(SECRET),
  });
  if (restack) expect((await turn(a, true)).status).toBe(200);
  return { a, data };
}

const attributes = (iid: number, source: string, target: string) => ({
  id: 100 + iid,
  iid,
  title: `Step ${iid}`,
  url: `${GITLAB}/${FULL_NAME}/-/merge_requests/${iid}`,
  source_branch: source,
  target_branch: target,
  source_project_id: 9,
  target_project_id: 9,
  last_commit: { id: sha(iid) },
  updated_at: new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC"),
});

const project = { id: 9, path_with_namespace: FULL_NAME };

/** !1, from step-1, merged into main by squash. */
const merged = {
  object_kind: "merge_request",
  project,
  object_attributes: {
    ...attributes(1, "step-1", "main"),
    action: "merge",
    state: "merged",
    squash_commit_sha: mergeOf(1),
    merge_commit_sha: null,
  },
};

/** !iid moved off `from` onto `target`. */
const moved = (iid: number, from: string, target: string, source = 9) => ({
  object_kind: "merge_request",
  project,
  object_attributes: {
    ...attributes(iid, `step-${iid}`, target),
    action: "update",
    state: "opened",
    source_project_id: source,
  },
  changes: { target_branch: { previous: from, current: target } },
});

const deliver = async (body: unknown) => {
  const res = await gitlabHook(SECRET, body);
  expect(res.status).toBe(202);
};

const queued = async (a: Awaited<ReturnType<typeof signInWithGithub>>) =>
  (await history(a)).jobs.map((j) => [j.number, j.parent, j.branch, j.onto, j.from, j.state]);

describe("restacking a merge request after a merge on GitLab", () => {
  it("moves and queues the ones stacked on the merged one from the merge's hook", async () => {
    const lab = gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "step-1", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(merged);
    expect(lab.moved).toEqual([2]);
    expect(await queued(a)).toEqual([[2, 1, "step-2", "main", sha(2), "queued"]]);
    // The update hook ocra's own move sends queues nothing more.
    await deliver(moved(2, "step-1", "main"));
    expect(await queued(a)).toEqual([[2, 1, "step-2", "main", sha(2), "queued"]]);
  });

  it("queues one GitLab moved itself before the merge's hook was handled", async () => {
    // GitLab already moved !2 to main when it deleted step-1.
    const lab = gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(merged);
    expect(lab.moved).toEqual([]);
    expect(await queued(a)).toEqual([]);
    // Delivered twice, it queues one.
    await deliver(moved(2, "step-1", "main"));
    await deliver(moved(2, "step-1", "main"));
    expect(await queued(a)).toEqual([[2, 1, "step-2", "main", sha(2), "queued"]]);
  });

  it("queues nothing where the project has restacks off", async () => {
    gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(false);
    await deliver(merged);
    await deliver(moved(2, "step-1", "main"));
    expect(await queued(a)).toEqual([]);
  });

  it("queues nothing for a move off a branch that did not merge, or onto another base", async () => {
    gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "release", state: "opened" },
      { iid: 3, source: "step-3", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(merged);
    // The index cannot tell where the merged one went: the platform's answer does.
    await deliver(moved(2, "step-1", "release"));
    await deliver(moved(3, "step-9", "main"));
    expect(await queued(a)).toEqual([]);
  });

  it("queues nothing for a fork's merge request or an update that kept the target", async () => {
    gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(merged);
    await deliver(moved(2, "step-1", "main", 10));
    await deliver({ ...moved(2, "step-1", "main"), changes: {} });
    await deliver(moved(2, "main", "main"));
    expect(await queued(a)).toEqual([]);
  });

  it("queues one moved before the merge's hook indexed the merge, then nothing more", async () => {
    gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged" },
      { iid: 2, source: "step-2", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(moved(2, "step-1", "main"));
    const once = [[2, 1, "step-2", "main", sha(2), "queued"]];
    expect(await queued(a)).toEqual(once);
    await deliver(merged);
    await deliver(moved(2, "step-1", "main"));
    expect(await queued(a)).toEqual(once);
  });

  it("queues nothing from GitLab's answer for a merge out of the window or a live source", async () => {
    const lab = gitlab([
      { iid: 1, source: "step-1", target: "main", state: "merged", at: new Date(0) },
      { iid: 2, source: "step-2", target: "main", state: "opened" },
      { iid: 3, source: "step-3", target: "main", state: "merged" },
      { iid: 5, source: "step-3", target: "release", state: "opened" },
      { iid: 4, source: "step-4", target: "main", state: "opened" },
    ]);
    const { a } = await enrolled(true);
    await deliver(moved(2, "step-1", "main"));
    await deliver(moved(4, "step-3", "main"));
    expect(await queued(a)).toEqual([]);
    expect(lab.moved).toEqual([]);
  });
});

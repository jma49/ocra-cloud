import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HeldReleaseDraftView,
  ReleaseNotesView,
  ReleasePublishAnswer,
} from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// The same on GitLab: the range's commits from its compare, the merge
// requests merged since the range's oldest commit matched by their merge,
// squash or head commit. GitLab keeps no draft releases, so the draft is
// held here, one per tag with a version, until the user publishes it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const PROJECT = `${GITLAB}/api/v4/projects/${encodeURIComponent("group/sub/project")}`;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ELSEWHERE = "e".repeat(40);

const mr = (iid: number, title: string, over: Record<string, unknown>) => ({
  iid,
  title,
  web_url: `${GITLAB}/group/sub/project/-/merge_requests/${iid}`,
  merged_at: "2026-11-20T10:00:00Z",
  description: "",
  merge_commit_sha: null,
  squash_commit_sha: null,
  sha: ELSEWHERE,
  author: { username: `dev${iid}` },
  ...over,
});

type Release = { status: number; body?: unknown };

function gitlab(
  listed: unknown[],
  over: { tags?: string[]; refs?: string[]; release?: Release } = {},
) {
  const urls: string[] = [];
  const sent: unknown[] = [];
  const { tags = ["v1.0.0"], refs = ["main"], release } = over;
  githubFake({
    extra: async (req) => {
      if (!req.url.startsWith(PROJECT)) return undefined;
      urls.push(`${req.method} ${req.url}`);
      const url = new URL(req.url);
      const rest = req.url.slice(PROJECT.length);
      const named = (prefix: string, names: string[]) =>
        names.some((n) => rest === `${prefix}${encodeURIComponent(n)}`)
          ? Response.json({ name: "x" })
          : Response.json({ message: "404 Not Found" }, { status: 404 });
      if (rest.startsWith("/repository/tags/")) return named("/repository/tags/", tags);
      if (rest.startsWith("/repository/commits/")) return named("/repository/commits/", refs);
      if (rest === "/releases" && req.method === "POST") {
        sent.push(await req.json());
        const r = release ?? {
          status: 201,
          body: { _links: { self: `${GITLAB}/group/sub/project/-/releases/v1.1.0` } },
        };
        return Response.json(r.body ?? {}, { status: r.status });
      }
      if (url.pathname.endsWith("/repository/compare")) {
        if (url.searchParams.get("from") !== "v1.0.0") return Response.json({}, { status: 404 });
        return Response.json({
          commits: [
            { id: A, committed_date: "2026-11-19T08:00:00Z" },
            { id: B, committed_date: "2026-11-18T08:00:00Z" },
            { id: C, committed_date: "2026-11-20T08:00:00Z" },
          ],
        });
      }
      if (url.pathname.endsWith("/merge_requests")) return Response.json(listed);
      return undefined;
    },
  });
  return Object.assign(urls, { sent });
}

async function signedIn() {
  const a = await signInWithGithub();
  await (await connectGitlab(a))("code=c&state=STATE");
  return a;
}

const draft = (a: Awaited<ReturnType<typeof signedIn>>, from = "v1.0.0") =>
  a.send(`/api/release-notes?platform=gitlab&repo=group/sub/project&from=${from}&to=main`);

describe("release notes drafted on GitLab", () => {
  it("matches merge requests to the range by their merge, squash or head commit", async () => {
    const urls = gitlab([
      mr(3, "feat: merged", { merge_commit_sha: A }),
      mr(4, "fix(ui): squashed @here", { squash_commit_sha: B }),
      mr(5, "perf: fast-forwarded", { sha: C }),
      mr(6, "feat: merged elsewhere", {}),
      mr(7, "docs: breaking", { merge_commit_sha: A, description: "BREAKING CHANGE: gone" }),
    ]);
    const a = await signedIn();
    const res = await draft(a);
    expect(res.status).toBe(200);
    const view = (await res.json()) as ReleaseNotesView;
    expect(view.drafts).toBe(true);
    expect(view.held).toEqual([]);
    expect(view.pulls.map((p) => [p.number, p.section])).toEqual([
      [3, "added"],
      [4, "fixed"],
      [5, "performance"],
      [7, "breaking"],
    ]);
    expect(view.body).toContain(
      `- **ui:** squashed \\@\u200Bhere ([!4](${GITLAB}/group/sub/project/-/merge_requests/4), by @\u200Bdev4)`,
    );
    expect(view.body).toContain(
      `**Full changes:** [v1.0.0...main](${GITLAB}/group/sub/project/-/compare/v1.0.0...main)`,
    );
    expect(view.body).not.toMatch(/@\w/);
    // Merged since the oldest commit of the range, less a day for the committer's clock.
    const listing = new URL(urls.find((u) => u.includes("/merge_requests?"))?.slice(4) ?? "");
    expect(listing.searchParams.get("state")).toBe("merged");
    expect(listing.searchParams.get("updated_after")).toBe("2026-11-17T08:00:00.000Z");
  });

  it("says a full listing may have held more", async () => {
    gitlab(Array.from({ length: 100 }, (_, i) => mr(i + 1, "feat: x", {})));
    const a = await signedIn();
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.truncated).toBe(true);
  });

  it("answers not found for a ref the project lacks", async () => {
    gitlab([]);
    const a = await signedIn();
    expect((await draft(a, "v0.0.1")).status).toBe(404);
  });
});

type Signed = Awaited<ReturnType<typeof signedIn>>;

const save = (a: Signed, over: Record<string, unknown> = {}) =>
  a.send("/api/release-notes/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "gitlab",
      repo: "group/sub/project",
      tag: "v1.1.0",
      target: "main",
      name: "v1.1.0",
      body: "Notes.",
      draft: true,
      ...over,
    }),
  });

const held = async (a: Signed) => {
  const res = (await save(a)).json() as Promise<ReleasePublishAnswer>;
  const answer = await res;
  if (answer.outcome !== "held") throw new Error(answer.outcome);
  return answer.draft;
};

const publish = (a: Signed, d: HeldReleaseDraftView, version = d.version) =>
  a.send(`/api/release-notes/held/${d.id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });

describe("a draft release on GitLab", () => {
  it("is held here, not sent: GitLab is only asked whether the tag is free and the target is", async () => {
    const urls = gitlab([]);
    const a = await signedIn();
    const res = await save(a);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ReleasePublishAnswer;
    expect(answer).toMatchObject({
      outcome: "held",
      draft: { tag: "v1.1.0", target: "main", name: "v1.1.0", body: "Notes.", version: 1 },
    });
    expect(urls.filter((u) => !u.startsWith("GET "))).toEqual([]);
    expect(urls.map((u) => u.slice(4 + PROJECT.length))).toEqual([
      "/repository/commits/main",
      "/repository/tags/v1.1.0",
    ]);
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.held?.map((d) => [d.tag, d.version])).toEqual([["v1.1.0", 1]]);
  });

  it("edits a held draft only from the version it read", async () => {
    gitlab([]);
    const a = await signedIn();
    const first = await held(a);
    // A second start of the same tag, as from another tab, is stale.
    const again = await save(a, { body: "Other tab." });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "stale", version: 1 });
    const edited = await save(a, { version: 1, body: "Edited." });
    expect(await edited.json()).toMatchObject({
      outcome: "held",
      draft: { id: first.id, body: "Edited.", version: 2 },
    });
    const late = await save(a, { version: 1, body: "Late." });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "stale", version: 2 });
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.held?.map((d) => [d.body, d.version])).toEqual([["Edited.", 2]]);
  });

  it("refuses a tag that exists and a target that does not, holding nothing", async () => {
    gitlab([]);
    const a = await signedIn();
    expect(await (await save(a, { tag: "v1.0.0" })).json()).toEqual({ outcome: "tag_exists" });
    expect(await (await save(a, { target: "gone" })).json()).toEqual({
      outcome: "target_missing",
    });
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.held).toEqual([]);
  });

  it("publishes as a GitLab release with its tag at the target, then drops the held draft", async () => {
    const urls = gitlab([]);
    const a = await signedIn();
    const d = await held(a);
    const stale = await publish(a, d, 2);
    expect(stale.status).toBe(409);
    expect(urls.sent).toEqual([]);
    const res = await publish(a, d);
    expect(await res.json()).toEqual({
      outcome: "published",
      url: `${GITLAB}/group/sub/project/-/releases/v1.1.0`,
    });
    expect(urls.sent).toEqual([
      { tag_name: "v1.1.0", ref: "main", name: "v1.1.0", description: "Notes." },
    ]);
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.held).toEqual([]);
    expect((await publish(a, d)).status).toBe(404);
  });

  it("keeps the held draft when GitLab refuses the release", async () => {
    gitlab([], { release: { status: 403 } });
    const a = await signedIn();
    const d = await held(a);
    expect(await (await publish(a, d)).json()).toEqual({ outcome: "refused" });
    const view = (await (await draft(a)).json()) as ReleaseNotesView;
    expect(view.held?.map((h) => h.id)).toEqual([d.id]);
  });

  it("discards a held draft only at the version it read", async () => {
    gitlab([]);
    const a = await signedIn();
    const d = await held(a);
    const stale = await a.send(`/api/release-notes/held/${d.id}?version=2`, { method: "DELETE" });
    expect(stale.status).toBe(409);
    const ok = await a.send(`/api/release-notes/held/${d.id}?version=1`, { method: "DELETE" });
    expect(await ok.json()).toEqual({ removed: true });
    const gone = await a.send(`/api/release-notes/held/${d.id}?version=1`, { method: "DELETE" });
    expect(gone.status).toBe(404);
  });
});

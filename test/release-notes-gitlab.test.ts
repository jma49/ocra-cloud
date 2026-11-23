import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseNotesView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { connectGitlab, GITLAB, githubFake, signInWithGithub } from "./platform-fakes.js";

// The same on GitLab: the range's commits from its compare, the merge
// requests merged since the range's oldest commit matched by their merge,
// squash or head commit, and no draft release, which GitLab does not keep.

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

function gitlab(listed: unknown[]) {
  const urls: string[] = [];
  githubFake({
    extra: (req) => {
      if (!req.url.startsWith(PROJECT)) return undefined;
      urls.push(`${req.method} ${req.url}`);
      const url = new URL(req.url);
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
  return urls;
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
    expect(view.drafts).toBe(false);
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

describe("a draft release on GitLab", () => {
  it("is answered unsupported, and nothing is sent", async () => {
    const urls = gitlab([]);
    const a = await signedIn();
    const res = await a.send("/api/release-notes/publish", {
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
      }),
    });
    expect(await res.json()).toEqual({ outcome: "unsupported" });
    expect(urls).toEqual([]);
  });
});

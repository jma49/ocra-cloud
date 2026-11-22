import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// An enrolled repository's pull requests as they end: the platforms'
// webhooks record each merge or close once, the newest winning.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-closed-pulls-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
beforeEach(async () => {
  s = await graphServer(dir, `closed-pulls-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    workers: 0,
  });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const enroll = (auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/auto-review/repos", { method: "POST", headers: auth, json });

const closed = (number: number, pull: Record<string, unknown>, repo = 11) =>
  JSON.stringify({
    action: "closed",
    number,
    pull_request: { draft: false, head: { sha: C1 }, title: "Add the cache", ...pull },
    repository: { id: repo, full_name: "octo/api" },
  });

async function fromGithub(body: string) {
  return s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

const stored = async () =>
  (await s.host.db.select().from(schema.closedPulls).orderBy(schema.closedPulls.number)).map(
    (p) => [
      p.number,
      p.merged,
      p.title,
      p.openedAt?.toISOString() ?? null,
      p.closedAt.toISOString(),
    ],
  );

describe("a pull request's close", () => {
  it("is recorded once per pull request from GitHub, a newer close replacing an older", async () => {
    const { auth } = await s.signIn(1);
    await enroll(auth, { platform: "github", fullName: "octo/api" });
    const merge = closed(7, {
      merged: true,
      created_at: "2026-11-20T10:00:00Z",
      merged_at: "2026-11-21T12:00:00Z",
      closed_at: "2026-11-21T12:00:00Z",
    });
    const deliveries = await Promise.all([fromGithub(merge), fromGithub(merge)]);
    expect(deliveries.map((r) => r.status)).toEqual([202, 202]);
    // Closed before it was reopened and merged: an older close, delivered late.
    await fromGithub(closed(7, { merged: false, closed_at: "2026-11-20T18:00:00Z" }));
    await fromGithub(closed(8, { merged: false, closed_at: "2026-11-21T09:00:00Z" }));
    // Not enrolled: nothing is kept.
    await fromGithub(closed(9, { merged: true, merged_at: "2026-11-21T09:00:00Z" }, 99));
    expect(await stored()).toEqual([
      [7, true, "Add the cache", "2026-11-20T10:00:00.000Z", "2026-11-21T12:00:00.000Z"],
      [8, false, "Add the cache", null, "2026-11-21T09:00:00.000Z"],
    ]);
  });

  it("is recorded from GitLab's merge request hook as it merges or closes", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T12:00:00Z"), toFake: ["Date"] });
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const hook = (attributes: Record<string, unknown>) =>
      s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhook.secret },
        json: {
          object_attributes: {
            last_commit: { id: C1 },
            title: "Add the cache",
            created_at: "2026-11-20 10:00:00 UTC",
            ...attributes,
          },
          project: { id: 21, path_with_namespace: "group/api" },
        },
      });
    expect(await (await hook({ iid: 3, action: "merge", state: "merged" })).json()).toEqual({
      queued: 0,
    });
    await hook({ iid: 4, action: "close", state: "closed" });
    // An edit of a closed merge request is not a close.
    await hook({ iid: 5, action: "update", state: "closed" });
    vi.useRealTimers();
    expect(await stored()).toEqual([
      [3, true, "Add the cache", "2026-11-20T10:00:00.000Z", "2026-11-21T12:00:00.000Z"],
      [4, false, "Add the cache", "2026-11-20T10:00:00.000Z", "2026-11-21T12:00:00.000Z"],
    ]);
  });
});

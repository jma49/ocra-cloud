import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// A webhook that changes what the inbox shows of an enrolled repository's
// pull request moves the account's change time; one about a branch with no
// pull request, or an issue, leaves it where it was.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-pulls-changed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let s: Server;
beforeEach(async () => {
  s = await graphServer(dir, `pulls-changed-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    workers: 0,
  });
  repoFake({ [C1]: {} });
});
afterEach(() => s.host.close());

const enroll = (auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/auto-review/repos", { method: "POST", headers: auth, json });

const changedAt = async (auth: Record<string, string>) =>
  (
    (await (await s.call("/api/platforms/pulls/changed", { headers: auth })).json()) as {
      changedAt: string | null;
    }
  ).changedAt;

const at = (hour: number) => new Date(Date.UTC(2026, 10, 21, hour));

async function fromGithub(event: string, payload: Record<string, unknown>, hour: number) {
  vi.useFakeTimers({ now: at(hour), toFake: ["Date"] });
  const body = JSON.stringify({ ...payload, repository: { id: 11, full_name: "octo/api" } });
  const res = await s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
  vi.useRealTimers();
  expect(res.status).toBe(202);
}

describe("a webhook's change to the inbox", () => {
  it("moves the change time on GitHub when it concerns a pull request", async () => {
    const { auth } = await s.signIn(1);
    const enrolled = await enroll(auth, { platform: "github", fullName: "octo/api" });
    expect(enrolled.status, await enrolled.clone().text()).toBe(200);
    await fromGithub("status", { sha: C1, state: "success" }, 1);
    await fromGithub("check_suite", { action: "completed", check_suite: { pull_requests: [] } }, 2);
    await fromGithub("issue_comment", { action: "created", issue: { number: 3 } }, 3);
    await fromGithub("push", { ref: "refs/heads/main", after: C1 }, 4);
    expect(await changedAt(auth)).toBeNull();

    const review = { action: "submitted", review: { id: 1, state: "approved" } };
    await fromGithub("pull_request_review", review, 5);
    expect(await changedAt(auth)).toBe(at(5).toISOString());
    const comment = { action: "created", issue: { number: 7, pull_request: { url: "x" } } };
    await fromGithub("issue_comment", comment, 6);
    expect(await changedAt(auth)).toBe(at(6).toISOString());
    const suite = { action: "completed", check_suite: { pull_requests: [{ number: 7 }] } };
    await fromGithub("check_suite", suite, 7);
    expect(await changedAt(auth)).toBe(at(7).toISOString());
    // Someone else's account hears nothing of it.
    expect(await changedAt((await s.signIn(2)).auth)).toBeNull();
  });

  it("moves the change time on GitLab for a merge request's hooks only", async () => {
    const { auth } = await s.signIn(1);
    const res = await enroll(auth, { platform: "gitlab", fullName: "group/api" });
    const { webhook } = (await res.json()) as { webhook: { secret: string } };
    const hook = async (kind: string, json: Record<string, unknown>, hour: number) => {
      vi.useFakeTimers({ now: at(hour), toFake: ["Date"] });
      const sent = await s.call("/api/auto-review/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": kind, "x-gitlab-token": webhook.secret },
        json: { ...json, project: { id: 21, path_with_namespace: "group/api" } },
      });
      vi.useRealTimers();
      expect(sent.status).toBe(202);
    };
    const pipeline = { object_kind: "pipeline", object_attributes: { id: 5, status: "success" } };
    await hook("Pipeline Hook", pipeline, 1);
    expect(await changedAt(auth)).toBeNull();
    await hook("Pipeline Hook", { ...pipeline, merge_request: { iid: 3 } }, 2);
    expect(await changedAt(auth)).toBe(at(2).toISOString());
    const mr = { iid: 3, action: "approved", state: "opened", last_commit: { id: C1 } };
    await hook("Merge Request Hook", { object_attributes: mr }, 3);
    expect(await changedAt(auth)).toBe(at(3).toISOString());
  });
});

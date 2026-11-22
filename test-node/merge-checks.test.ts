import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import type { BotTokens } from "../src/platforms/bot.js";
import { C1, C2, repoFake } from "./graph-fakes.js";
import { graphServer, SECRET, type Server } from "./graph-server.js";

// An enrolled repository's pre-merge checks, evaluated when the webhook
// queues a pull request's head and when its review lands, and posted as
// the bot: one check run per head, updated when the result changes.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-merge-checks-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const bots: BotTokens = { forRepo: async () => ({ token: "ghs_bot" }) };
const API = "https://api.github.com/repos/Octo/API";

type Sent = { method: string; url: string; auth: string | null; body: Record<string, unknown> };

let s: Server;
let sent: Sent[];
let pullTitle: string;
beforeEach(async () => {
  s = await graphServer(dir, `merge-checks-${n++}.db`, "off", undefined, {
    bots: {},
    tokens: bots,
    workers: 0,
  });
  sent = [];
  pullTitle = "Cap refunds";
  const fake = repoFake({ [C1]: {} });
  const base = fake.fetch.getMockImplementation();
  fake.fetch.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.method === "GET" && req.url === `${API}/pulls/7`) {
      return Response.json({
        title: pullTitle,
        body: "## Why\nRefunds ran over.",
        head: { sha: C2 },
        changed_files: 2,
        additions: 10,
        deletions: 2,
      });
    }
    if (req.url.startsWith(`${API}/check-runs`)) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push({ method: req.method, url: req.url, auth: req.headers.get("authorization"), body });
      return Response.json({ id: 900 }, { status: req.method === "POST" ? 201 : 200 });
    }
    if (!base) throw new Error("no base fake");
    return base(input, init);
  });
});
afterEach(() => s.host.close());

async function enrolledWithChecks() {
  const me = await s.signIn(1);
  const res = await s.call("/api/auto-review/repos", {
    method: "POST",
    headers: me.auth,
    json: { platform: "github", fullName: "octo/api" },
  });
  const { repo } = (await res.json()) as { repo: { id: string } };
  for (const json of [
    { kind: "title", mode: "warn", settings: { prefixes: ["feat", "fix"] } },
    { kind: "critical_findings", mode: "block" },
    { kind: "instruction", mode: "block", settings: { text: "Refund code logs every refund." } },
  ]) {
    const added = await s.call(`/api/merge-checks/repos/${repo.id}/checks`, {
      method: "POST",
      headers: me.auth,
      json,
    });
    expect(added.status).toBe(200);
  }
  return me;
}

async function pullEvent(action: string) {
  const body = JSON.stringify({
    action,
    number: 7,
    pull_request: { draft: false, head: { sha: C2 } },
    repository: { id: 11, full_name: "Octo/API" },
  });
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

const runs = () => s.host.db.select().from(schema.mergeCheckRuns);
const posted = () => vi.waitFor(async () => expect((await runs())[0]?.postedAt).toBeTruthy());

describe("pre-merge checks on an enrolled repository", () => {
  it("are posted as one check run when the webhook queues the head, once per result", async () => {
    await enrolledWithChecks();
    expect((await pullEvent("opened")).status).toBe(202);
    await posted();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${API}/check-runs`,
      auth: "Bearer ghs_bot",
      body: {
        name: "ocra / pre-merge",
        head_sha: C2,
        // Blocking checks wait on the head's review, which has not landed: in progress.
        status: "in_progress",
        output: { title: "Waiting for the review: 2 checks not evaluated yet" },
      },
    });
    expect(sent[0]?.body).not.toHaveProperty("conclusion");
    const summary = (sent[0]?.body.output as { summary?: string } | undefined)?.summary;
    expect(summary).toContain("**Critical findings** (blocking): not evaluated yet: ocra has not");
    expect(summary).toContain(
      "**Instruction** (blocking): not evaluated yet: no ocra review of this head judged",
    );
    expect(summary).toContain("**Title** (warning): failed, the title does not start with");

    // The same head and result again: nothing more is posted.
    await pullEvent("synchronize");
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(1);

    // A retitled pull request changes the result: the same check run is updated.
    pullTitle = "feat: cap refunds";
    await pullEvent("edited");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      method: "PATCH",
      url: `${API}/check-runs/900`,
      body: { status: "in_progress" },
    });
    expect(sent[1]?.body.output).not.toMatchObject({ summary: expect.stringContaining("failed") });
    expect(await runs()).toHaveLength(1);
  });

  it("pass checks that wait on the review when the repository does not hold for it", async () => {
    const me = await enrolledWithChecks();
    const listed = await s.call("/api/auto-review/repos", { headers: me.auth });
    const { repos } = (await listed.json()) as { repos: { id: string }[] };
    const repo = `/api/merge-checks/repos/${repos[0]?.id}`;
    const before = (await (await s.call(`${repo}/checks`, { headers: me.auth })).json()) as {
      holdUnreviewed: boolean;
    };
    expect(before.holdUnreviewed).toBe(true);
    const changed = await s.call(repo, {
      method: "PATCH",
      headers: me.auth,
      json: { holdUnreviewed: false },
    });
    expect(await changed.json()).toEqual({ holdUnreviewed: false });
    await pullEvent("opened");
    await posted();
    expect(sent[0]?.body).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Passed with 1 warning" },
    });
  });

  it("block the head once its review lands with an unresolved critical finding", async () => {
    const me = await enrolledWithChecks();
    await pullEvent("opened");
    await posted();
    const review = (repository: string) => ({
      runId: `run-${repository.length}`,
      durationMs: 1000,
      repoHash: "b".repeat(64),
      source: "github",
      findings: { critical: 1, warning: 0, suggestion: 0 },
      pullRequest: { repository, number: 7, headSha: C2 },
    });
    // A review naming the same path on another host is not this pull request's.
    const forged = await s.call("/api/reviews", {
      method: "POST",
      headers: me.auth,
      json: review("https://evil.example/octo/api"),
    });
    expect(forged.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(1);

    await s.call("/api/reviews", {
      method: "POST",
      headers: me.auth,
      json: review("https://github.com/octo/api"),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      method: "PATCH",
      body: { conclusion: "failure", output: { title: "1 blocking check failed" } },
    });
    const page = await s.call("/api/pulls/checks?platform=github&repo=Octo/API&number=7", {
      headers: me.auth,
    });
    expect(await page.json()).toMatchObject({
      report: { head: C2, conclusion: "failure" },
      postedAt: expect.any(String),
    });
  });

  it("are not evaluated for a repository without checks", async () => {
    const me = await s.signIn(1);
    await s.call("/api/auto-review/repos", {
      method: "POST",
      headers: me.auth,
      json: { platform: "github", fullName: "octo/api" },
    });
    await pullEvent("opened");
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });
});

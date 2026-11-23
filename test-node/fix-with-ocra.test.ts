import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import type { Exec } from "../src/node/checkout.js";
import { runNextFix } from "../src/node/review-runner.js";
import type { BotAccess } from "../src/platforms/bot.js";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { reviewRow } from "../src/reviews.js";
import { type FixRequestView, MAX_DAILY_FIX_REQUESTS } from "../src/shared/index.js";
import { utcDay } from "../src/time.js";
import { finding, upload } from "../test/finding-uploads.js";
import { C1 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// "Fix with ocra": a stored finding of a hosted review that came without a
// fix gets one asked of `ocra fix` in the runner, once per finding and
// head, and a proposed fix becomes the finding's own.

const TOKEN = "runner-token-of-at-least-32-characters";

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-fix-with-ocra-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
let accountId: string;
let auth: Record<string, string>;
let findingId: string;
const access: (BotAccess | undefined)[] = [];
const bots = {
  forRepo: async (_repo: unknown, a?: BotAccess) => {
    access.push(a);
    return { token: "ghs_bot", login: "ocra-review[bot]" };
  },
};
const platforms = [
  github({ host: GITHUB_COM, id: "self-hosted-app", secret: "test-client-secret" }),
];

/** A hosted review of Octo/API#7 at C1 with one finding; the finding's id. */
async function seedFinding(over: Record<string, unknown> = {}, run = "run-1") {
  const data = scoped(s.host.db, accountId);
  const { reviewersDropped: _, ...row } = reviewRow(
    reviewUploadSchema.parse({
      ...upload(run, []),
      pullRequest: { repository: "https://github.com/Octo/API", number: 7, headSha: C1 },
    }),
  );
  const { rows } = parseFindings([finding(over)]);
  const stored = await data.insertReview(row, rows, { dailyUploads: 10, maxFindings: 10 });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  const [f] = await data.findingsOf(stored.id);
  return f?.id ?? "";
}

beforeEach(async () => {
  access.length = 0;
  const passed = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url.startsWith(GITHUB_COM.api) || url === GITHUB_COM.graphql) {
      return new Response(null, { status: 404 });
    }
    return passed(input, init);
  });
  s = await graphServer(dir, `fix-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    tokens: bots,
    workers: 0,
    runnerToken: TOKEN,
  });
  const me = await s.signIn(1);
  accountId = me.account.id;
  auth = me.auth;
  await scoped(s.host.db, accountId).autoReview.enroll(
    { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
    100,
  );
  findingId = await seedFinding({
    lowConfidence: true,
    evidence: ["`id` comes from the request"],
  });
});
afterEach(() => s.host.close());

const ask = (json: Record<string, unknown>, headers = auth) =>
  s.call("/api/auto-review/fixes", { method: "POST", headers, json });
const jobs = () => scoped(s.host.db, accountId).list("fixJobs");
const stored = async () => scoped(s.host.db, accountId).get("findings", findingId);

const FIX = { startLine: 10, endLine: 10, replacement: "db.query(sql, [id]);" };
const answer = (over: Record<string, unknown> = {}) => ({
  fingerprint: "fp-1234",
  headSha: C1,
  outcome: "proposed",
  fix: FIX,
  reason: null,
  usage: {
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    costUsd: 0.01,
  },
  ...over,
});

type Seen = { args: string[]; input?: unknown; stdout?: true; limit?: number | undefined };

/** The machine: git clones, the CLI prints `printed` and exits with code. */
function fakeExec(printed: string, code = 0) {
  const seen: Seen = { args: [] };
  const exec: Exec = async (command, args, options) => {
    if (command === "git") {
      await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
      return { code: 0 };
    }
    seen.args = [...args];
    const file = args[args.indexOf("--finding") + 1] ?? "";
    seen.input = JSON.parse(await readFile(file, "utf8"));
    if (options.stdout) seen.stdout = true;
    seen.limit = options.stdoutLimit;
    return { code, ...(options.stdout ? { stdout: printed } : {}) };
  };
  return { exec, seen };
}

const runFix = (exec: Exec) =>
  runNextFix({
    db: s.host.db,
    platforms,
    bots,
    publicUrl: ORIGIN,
    dailyCalls: 1000,
    exec,
    cli: "/opt/ocra/main.js",
  });

describe("an uploaded finding", () => {
  it("keeps whether it is low confidence and its evidence, redacted", async () => {
    const f = await stored();
    expect(f).toMatchObject({ lowConfidence: true, evidence: ["`id` comes from the request"] });
    const plain = await seedFinding({}, "run-2");
    expect(await scoped(s.host.db, accountId).get("findings", plain)).toMatchObject({
      lowConfidence: false,
      evidence: null,
    });
    const secret = await seedFinding(
      { evidence: ["token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB was read"] },
      "run-3",
    );
    const kept = await scoped(s.host.db, accountId).get("findings", secret);
    expect(JSON.stringify(kept?.evidence)).not.toContain("ghp_0123456789");
    expect(kept?.redacted).toBe(true);
  });
});

describe("asking for a fix", () => {
  it("queues one per finding and head, and answers the request already made", async () => {
    const first = (await (await ask({ finding: findingId })).json()) as FixRequestView;
    const again = await (await ask({ finding: findingId })).json();
    expect(first).toMatchObject({
      outcome: "queued",
      job: { finding: findingId, head: C1, state: "queued", outcome: null },
    });
    expect(again).toMatchObject({ outcome: "requested", job: { id: first.job?.id } });
    expect(await jobs()).toHaveLength(1);
    const one = await s.call(`/api/auto-review/fixes/finding/${findingId}`, { headers: auth });
    expect(await one.json()).toMatchObject({ job: { id: first.job?.id, state: "queued" } });
    const listed = await s.call("/api/auto-review/fixes?platform=github&repo=Octo/API&number=7", {
      headers: auth,
    });
    expect(await listed.json()).toMatchObject({ enrolled: true, jobs: [{ id: first.job?.id }] });
    const audited = await scoped(s.host.db, accountId).list("auditEvents");
    expect(audited.filter((e) => e.kind === "pull.fix_requested")).toHaveLength(1);
    // The second request counted nothing.
    const [count] = await scoped(s.host.db, accountId).find("usageCounters", {
      kind: "fix_requests",
    });
    expect(count?.n).toBe(1);
  });

  it("is refused for another account's finding and answers a finding with a fix", async () => {
    const other = await s.signIn(2);
    expect((await ask({ finding: findingId }, other.auth)).status).toBe(404);
    const withFix = await seedFinding(
      { fingerprint: "fp-fixed", fix: { startLine: 1, endLine: 1, replacement: "x" } },
      "run-2",
    );
    expect(await (await ask({ finding: withFix })).json()).toEqual({
      outcome: "has_fix",
      job: null,
    });
    expect(await jobs()).toEqual([]);
  });

  it("stops at the account's requests for the day", async () => {
    await scoped(s.host.db, accountId).insert("usageCounters", {
      kind: "fix_requests",
      day: utcDay(new Date()),
      n: MAX_DAILY_FIX_REQUESTS,
    });
    const res = await ask({ finding: findingId });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "daily_limit", limit: MAX_DAILY_FIX_REQUESTS });
    expect(await jobs()).toEqual([]);
  });
});

describe("a fix's run", () => {
  it("runs ocra fix read-only on the reviewed head and makes a proposed fix the finding's", async () => {
    await ask({ finding: findingId });
    const { exec, seen } = fakeExec(`${JSON.stringify(answer())}\n`);
    expect(await runFix(exec)).toBe(true);
    expect(access).toEqual([undefined]);
    expect(seen.args).toEqual([
      "/opt/ocra/main.js",
      "fix",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--head",
      C1,
      "--json",
      "--finding",
      expect.stringMatching(/finding\.json$/),
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(seen.stdout).toBe(true);
    expect(seen.limit).toBeGreaterThan(4096);
    expect(seen.input).toMatchObject({
      fingerprint: "fp-1234",
      file: "src/db.ts",
      lowConfidence: true,
      evidence: ["`id` comes from the request"],
    });
    expect((await jobs())[0]).toMatchObject({
      state: "done",
      outcome: "proposed",
      reason: null,
    });
    expect(await stored()).toMatchObject({
      fixStartLine: 10,
      fixEndLine: 10,
      fixReplacement: FIX.replacement,
    });
    const feed = await scoped(s.host.db, accountId).list("notificationFeed");
    expect(feed).toMatchObject([
      { kind: "fix_finished", title: expect.stringContaining("proposed") },
    ]);
    const audited = await scoped(s.host.db, accountId).list("auditEvents");
    expect(audited.find((e) => e.kind === "pull.fix_answered")?.detail).toMatchObject({
      outcome: "proposed",
    });
    const sessions = await scoped(s.host.db, accountId).list("sessions");
    expect(sessions.filter((x) => x.label === "auto review")).toEqual([]);
    // A second request answers the one made: the finding has its fix.
    expect(await (await ask({ finding: findingId })).json()).toMatchObject({ outcome: "has_fix" });
  });

  it("records an answer without a fix, and tells of it", async () => {
    await ask({ finding: findingId });
    const none = answer({ outcome: "not_fixable", fix: null, reason: "not_candidate" });
    const { exec } = fakeExec(JSON.stringify(none));
    await runFix(exec);
    expect((await jobs())[0]).toMatchObject({
      state: "done",
      outcome: "not_fixable",
      reason: "not_candidate",
    });
    expect((await stored())?.fixReplacement).toBeNull();
    const feed = await scoped(s.host.db, accountId).list("notificationFeed");
    expect(feed).toMatchObject([
      { kind: "fix_finished", title: expect.stringContaining("no fix") },
    ]);
  });

  it("fails a run whose answer is unreadable or another finding's, to be tried again", async () => {
    await ask({ finding: findingId });
    await runFix(fakeExec("[ocra] something went wrong").exec);
    expect((await jobs())[0]).toMatchObject({ state: "queued", error: "review_failed" });
    await scoped(s.host.db, accountId).update("fixJobs", (await jobs())[0]?.id ?? "", {
      notBefore: null,
    });
    await runFix(fakeExec(JSON.stringify(answer({ fingerprint: "fp-other" }))).exec);
    expect((await jobs())[0]).toMatchObject({ attempts: 2, error: "review_failed" });
    expect((await stored())?.fixReplacement).toBeNull();
  });

  it("can be asked again once it failed", async () => {
    await ask({ finding: findingId });
    const [job] = await jobs();
    await scoped(s.host.db, accountId).update("fixJobs", job?.id ?? "", {
      state: "failed",
      error: "lease_lapsed",
    });
    expect(await (await ask({ finding: findingId })).json()).toMatchObject({
      outcome: "queued",
      job: { id: job?.id, state: "queued", error: null },
    });
  });
});

describe("a remote runner", () => {
  const asRunner = (path: string, json: unknown) =>
    s.call(`/api/runner/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      json,
    });
  const hello = { name: "mini", version: "0.19.0" };

  it("is given a fix only when it says it runs them, and settles it with its answer", async () => {
    await ask({ finding: findingId });
    expect(await (await asRunner("claim", hello)).json()).toEqual({ assignment: null });
    const claimed = (await (await asRunner("claim", { ...hello, fix: true })).json()) as {
      assignment: { id: string };
    };
    expect(claimed.assignment).toMatchObject({
      kind: "fix",
      args: ["fix", "--pr", "7", "--repo", "Octo/API", "--head", C1, "--json"],
      ok: [0, 3],
      finding: { fingerprint: "fp-1234", lowConfidence: true },
    });
    const ref = { id: claimed.assignment.id, accountId, attempts: 1 };
    expect((await asRunner("settle", { ...ref, kind: "fix", failure: null })).status).toBe(400);
    const settled = await asRunner("settle-fix", { ...ref, ran: { result: answer() } });
    expect(settled.status).toBe(200);
    expect((await jobs())[0]).toMatchObject({ state: "done", outcome: "proposed" });
    expect((await stored())?.fixReplacement).toBe(FIX.replacement);
  });
});

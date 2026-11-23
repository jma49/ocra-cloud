import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import type { Exec } from "../src/node/checkout.js";
import { runNextAnswered } from "../src/node/review-runner.js";
import type { BotAccess } from "../src/platforms/bot.js";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { reviewRow } from "../src/reviews.js";
import { MAX_DAILY_FIX_REQUESTS, type MendRequestView } from "../src/shared/index.js";
import { utcDay } from "../src/time.js";
import { finding, upload } from "../test/finding-uploads.js";
import { C1, C2, C3 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// A pull request's fix loop (ADR-0078): findings a person asks ocra to fix
// in a repository whose level is `commit` wait for a round of `ocra mend`
// in the runner, which the bot commits; what a round printed is recorded on
// the loop and on each finding.

const TOKEN = "runner-token-of-at-least-32-characters";

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-fix-loop-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let s: Server;
let accountId: string;
let auth: Record<string, string>;
let repoId: string;
let first: string;
let second: string;
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
const data = () => scoped(s.host.db, accountId);

/** A hosted review of Octo/API#7 at C1 with these findings; their ids, in order. */
async function seedReview(list: Record<string, unknown>[], run = "run-1") {
  const { reviewersDropped: _, ...row } = reviewRow(
    reviewUploadSchema.parse({
      ...upload(run, []),
      pullRequest: { repository: "https://github.com/Octo/API", number: 7, headSha: C1 },
    }),
  );
  const { rows } = parseFindings(list.map(finding));
  const stored = await data().insertReview(row, rows, { dailyUploads: 10, maxFindings: 10 });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  return (await data().findingsOf(stored.id)).map((f) => f.id);
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
  s = await graphServer(dir, `mend-${n++}.db`, "off", undefined, {
    bots: { githubApi: GITHUB_COM.api },
    tokens: bots,
    workers: 0,
    runnerToken: TOKEN,
  });
  const me = await s.signIn(1);
  accountId = me.account.id;
  auth = me.auth;
  await data().autoReview.enroll(
    { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
    100,
  );
  repoId = (await data().list("reviewRepos"))[0]?.id ?? "";
  [first = "", second = ""] = await seedReview([
    { fingerprint: "fp-warn", severity: "warning", title: "Unused branch" },
    { fingerprint: "fp-crit" },
  ]);
});
afterEach(() => s.host.close());

const setLevel = (mend: string, headers = auth) =>
  s.call(`/api/auto-review/repos/${repoId}/mend`, { method: "PUT", headers, json: { mend } });
const ask = async (findings: string[], headers = auth) =>
  s.call("/api/auto-review/mends", { method: "POST", headers, json: { findings } });
const asked = async (findings: string[]) => (await (await ask(findings)).json()) as MendRequestView;
const loop = async () => (await data().list("mendJobs"))[0];
const items = async () =>
  Object.fromEntries((await data().list("mendItems")).map((i) => [i.fingerprint, i]));
const view = async () =>
  (
    await s.call("/api/auto-review/mends?platform=github&repo=Octo/API&number=7", {
      headers: auth,
    })
  ).json();

const STATE = { rounds: 1, costUsd: 0.02, items: { "fp-crit": { attempts: 1 } } };
const EDIT = { path: "src/db.ts", startLine: 10, endLine: 10, replacement: "db.query(sql, [id]);" };
const item = (fingerprint: string, outcome: string, reason: string | null = null) => ({
  fingerprint,
  outcome,
  reason,
  edits: outcome === "fixed" ? [EDIT] : [],
});
const round = (over: Record<string, unknown> = {}) => ({
  headSha: C1,
  outcome: "committed",
  stopped: null,
  commitSha: C2,
  items: [item("fp-crit", "fixed"), item("fp-warn", "rejected", "unresolved")],
  state: STATE,
  usage: {
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    costUsd: 0.02,
  },
  ...over,
});

type Seen = { args: string[]; findings?: { fingerprint: string }[]; state?: unknown };

/** The machine: git clones, the CLI prints `printed` and exits with code. */
function fakeExec(printed: string, code = 0, during?: () => Promise<unknown>) {
  const seen: Seen = { args: [] };
  const exec: Exec = async (command, args, options) => {
    if (command === "git") {
      await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
      return { code: 0 };
    }
    seen.args = [...args];
    const file = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    seen.findings = JSON.parse(await readFile(file("--findings") ?? "", "utf8"));
    const state = file("--state");
    if (state) seen.state = JSON.parse(await readFile(state, "utf8"));
    await during?.();
    return { code, ...(options.stdout ? { stdout: printed } : {}) };
  };
  return { exec, seen };
}

/** Runs the loop's next round, past the wait that lets clicks share one. */
const runRound = (exec: Exec) =>
  runNextAnswered({
    db: s.host.db,
    platforms,
    bots,
    publicUrl: ORIGIN,
    dailyCalls: 1000,
    exec,
    cli: "/opt/ocra/main.js",
    now: () => new Date(Date.now() + 60_000),
  });

describe("the repository's level", () => {
  it("proposes until the account lets the bot commit, and refuses a request before that", async () => {
    expect(await asked([second])).toMatchObject({
      outcome: "not_enabled",
      mend: { level: "propose", loop: null, items: [] },
    });
    expect(await data().list("mendJobs")).toEqual([]);
    expect((await setLevel("off")).status).toBe(400);
    expect(await (await setLevel("commit")).json()).toEqual({ mend: "commit" });
    const audited = await data().list("auditEvents");
    expect(audited.find((e) => e.kind === "auto_review.mend_changed")?.detail).toMatchObject({
      repo: "Octo/API",
      mend: "commit",
    });
    const other = await s.signIn(2);
    expect((await setLevel("commit", other.auth)).status).toBe(404);
  });
});

describe("asking the loop for fixes", () => {
  beforeEach(() => setLevel("commit"));

  it("queues one round for the pull request and one item per finding, once", async () => {
    expect(await asked([first])).toMatchObject({
      outcome: "queued",
      mend: {
        level: "commit",
        loop: { state: "queued", outcome: null },
        items: [{ finding: first, outcome: null, commit: null }],
      },
    });
    expect(await asked([first, second])).toMatchObject({ outcome: "queued" });
    expect(await asked([first, second])).toMatchObject({ outcome: "requested" });
    expect(await data().list("mendJobs")).toHaveLength(1);
    expect(Object.keys(await items()).sort()).toEqual(["fp-crit", "fp-warn"]);
    expect(await view()).toMatchObject({ level: "commit", items: [{}, {}] });
    // Each finding counted once against the day's requests for fixes.
    const [count] = await data().find("usageCounters", { kind: "fix_requests" });
    expect(count?.n).toBe(2);
    const audited = await data().list("auditEvents");
    expect(
      audited.filter((e) => e.kind === "pull.mend_requested").map((e) => e.detail),
    ).toMatchObject([{ findings: 1 }, { findings: 1 }]);
  });

  it("is refused for another account's finding, findings of two reviews and a finding twice", async () => {
    const other = await s.signIn(2);
    expect((await ask([first], other.auth)).status).toBe(404);
    const [elsewhere = ""] = await seedReview([{ fingerprint: "fp-else" }], "run-2");
    expect((await ask([first, elsewhere])).status).toBe(404);
    expect((await ask([first, first])).status).toBe(400);
    expect((await ask(["no-such-finding"])).status).toBe(404);
    expect(await data().list("mendJobs")).toEqual([]);
  });

  it("asks nothing for a finding that is decided or low confidence", async () => {
    await data().update("findings", first, { status: "dismissed" });
    const [unsure = ""] = await seedReview(
      [{ fingerprint: "fp-unsure", lowConfidence: true }],
      "run-2",
    );
    expect(await asked([first])).toMatchObject({ outcome: "requested", mend: { items: [] } });
    expect(await asked([unsure])).toMatchObject({ outcome: "requested", mend: { items: [] } });
  });

  it("stops at the account's requests for the day", async () => {
    await data().insert("usageCounters", {
      kind: "fix_requests",
      day: utcDay(new Date()),
      n: MAX_DAILY_FIX_REQUESTS - 1,
    });
    expect(await asked([first, second])).toMatchObject({
      outcome: "queued",
      mend: { items: [{ finding: first }] },
    });
    const res = await ask([second]);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "daily_limit" });
  });
});

describe("a round", () => {
  beforeEach(() => setLevel("commit"));

  it("runs ocra mend as the bot that commits, on the findings that wait, the most severe first", async () => {
    await ask([first, second]);
    const { exec, seen } = fakeExec(`${JSON.stringify(round())}\n`);
    expect(await runRound(exec)).toBe(true);
    expect(access).toEqual(["commit"]);
    expect(seen.args).toEqual([
      "/opt/ocra/main.js",
      "mend",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--level",
      "commit",
      "--json",
      "--findings",
      expect.stringMatching(/input\.json$/),
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(seen.findings?.map((f) => f.fingerprint)).toEqual(["fp-crit", "fp-warn"]);
    expect(await loop()).toMatchObject({
      state: "done",
      outcome: "committed",
      commitSha: C2,
      loop: STATE,
    });
    expect(await items()).toMatchObject({
      "fp-crit": { outcome: "fixed", reason: null, commitSha: C2 },
      "fp-warn": { outcome: "rejected", reason: "unresolved", commitSha: null },
    });
    expect(await data().get("findings", second)).toMatchObject({
      status: "fixed",
      fixedVia: "applied",
    });
    expect(await data().get("findings", first)).toMatchObject({ status: "open" });
    const audited = await data().list("auditEvents");
    expect(audited.find((e) => e.kind === "pull.mend_committed")?.detail).toMatchObject({
      pull: "Octo/API#7",
      head: C1,
      commit: C2,
      fixed: 1,
    });
    expect(await data().list("notificationFeed")).toMatchObject([
      { kind: "fix_finished", title: "ocra committed a fix" },
    ]);
    const sessions = await data().list("sessions");
    expect(sessions.filter((x) => x.label === "auto review")).toEqual([]);
  });

  it("gives the next round the state the last one printed, and a rejected finding asked again", async () => {
    await ask([first, second]);
    await runRound(fakeExec(JSON.stringify(round())).exec);
    expect(await asked([first, second])).toMatchObject({
      outcome: "queued",
      mend: { loop: { state: "queued" } },
    });
    const next = round({
      headSha: C2,
      commitSha: C3,
      items: [item("fp-warn", "fixed")],
    });
    const { exec, seen } = fakeExec(JSON.stringify(next));
    await runRound(exec);
    expect(seen.args).toContain("--state");
    expect(seen.state).toEqual(STATE);
    // The finding the first round fixed is not given again.
    expect(seen.findings?.map((f) => f.fingerprint)).toEqual(["fp-warn"]);
    expect(await items()).toMatchObject({
      "fp-crit": { outcome: "fixed", commitSha: C2 },
      "fp-warn": { outcome: "fixed", commitSha: C3 },
    });
  });

  it("queues the loop again for a finding put off beside a commit, and ends one put off without", async () => {
    await ask([first, second]);
    const partly = round({
      items: [item("fp-crit", "fixed"), item("fp-warn", "deferred", "no_room")],
    });
    await runRound(fakeExec(JSON.stringify(partly)).exec);
    expect(await loop()).toMatchObject({ state: "queued", attempts: 0, commitSha: C2 });
    expect((await items())["fp-warn"]).toMatchObject({ outcome: null });
    const moved = round({
      outcome: "head_moved",
      commitSha: null,
      items: [item("fp-warn", "deferred", "head_moved")],
    });
    await runRound(fakeExec(JSON.stringify(moved), 3).exec);
    expect(await loop()).toMatchObject({ state: "done", outcome: "head_moved" });
    expect((await items())["fp-warn"]).toMatchObject({ outcome: "deferred", reason: "head_moved" });
  });

  it("runs again for a finding asked during it", async () => {
    await ask([second]);
    const only = round({ items: [item("fp-crit", "fixed")] });
    const { exec } = fakeExec(JSON.stringify(only), 0, () => ask([first]));
    await runRound(exec);
    expect(await loop()).toMatchObject({ state: "queued", again: false, attempts: 0 });
    expect(await items()).toMatchObject({
      "fp-crit": { outcome: "fixed" },
      "fp-warn": { outcome: null },
    });
  });

  it("fails a run whose answer is unreadable, to be tried again, and leaves the findings waiting", async () => {
    await ask([second]);
    await runRound(fakeExec("[ocra] something went wrong").exec);
    expect(await loop()).toMatchObject({ state: "queued", attempts: 1, error: "review_failed" });
    expect((await items())["fp-crit"]).toMatchObject({ outcome: null });
    expect((await data().get("findings", second))?.status).toBe("open");
  });

  it("runs nothing once the level is back to propose, or no asked finding is open", async () => {
    await ask([second]);
    await setLevel("propose");
    const { exec, seen } = fakeExec(JSON.stringify(round()));
    await runRound(exec);
    expect(seen.args).toEqual([]);
    expect(await loop()).toMatchObject({ state: "done", error: "switched_off" });
    await setLevel("commit");
    await ask([first]);
    await data().update("findings", first, { status: "dismissed" });
    await data().update("findings", second, { status: "dismissed" });
    await runRound(exec);
    expect(seen.args).toEqual([]);
    expect(await loop()).toMatchObject({ state: "done", error: "nothing_waiting" });
  });
});

describe("a remote runner", () => {
  beforeEach(() => setLevel("commit"));
  const asRunner = (path: string, json: unknown) =>
    s.call(`/api/runner/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      json,
    });
  const hello = { name: "mini", version: "0.20.0" };

  it("is given a round only when it says it runs them, and settles it with what the round printed", async () => {
    await ask([second]);
    await data().update("mendJobs", (await loop())?.id ?? "", { notBefore: null });
    expect(await (await asRunner("claim", { ...hello, answers: ["fix"] })).json()).toEqual({
      assignment: null,
    });
    const claimed = (await (await asRunner("claim", { ...hello, answers: ["mend"] })).json()) as {
      assignment: { id: string };
    };
    expect(claimed.assignment).toMatchObject({
      kind: "mend",
      args: ["mend", "--pr", "7", "--repo", "Octo/API", "--level", "commit", "--json"],
      ok: [0, 3],
      answered: { flag: "--findings", input: [{ fingerprint: "fp-crit" }], more: [] },
    });
    const ref = { kind: "mend", id: claimed.assignment.id, accountId, attempts: 1 };
    expect((await asRunner("settle", { ...ref, failure: null })).status).toBe(400);
    const result = round({ items: [item("fp-crit", "fixed")] });
    expect((await asRunner("settle-answer", { ...ref, ran: { answer: result } })).status).toBe(200);
    expect(await loop()).toMatchObject({ state: "done", outcome: "committed", commitSha: C2 });
    expect((await items())["fp-crit"]).toMatchObject({ outcome: "fixed", commitSha: C2 });
  });
});

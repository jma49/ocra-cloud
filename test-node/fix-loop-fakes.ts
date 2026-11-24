import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import type { Exec } from "../src/node/checkout.js";
import { runNextAnswered } from "../src/node/review-runner.js";
import type { BotAccess } from "../src/platforms/bot.js";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { reviewRow } from "../src/reviews.js";
import type { MendRequestView } from "../src/shared/index.js";
import { finding, upload } from "../test/finding-uploads.js";
import { C1, C2 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// What the fix loop's tests share: a round as `ocra mend --json` prints it,
// a machine that prints one, and a server with a reviewed pull request.

export const STATE = { rounds: 1, costUsd: 0.02, items: { "fp-crit": { attempts: 1 } } };
export const EDIT = {
  path: "src/db.ts",
  startLine: 10,
  endLine: 10,
  replacement: "db.query(sql, [id]);",
};
export const item = (fingerprint: string, outcome: string, reason: string | null = null) => ({
  fingerprint,
  outcome,
  reason,
  edits: outcome === "fixed" ? [EDIT] : [],
});
export const round = (over: Record<string, unknown> = {}) => ({
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
export function fakeExec(printed: string, code = 0, during?: () => Promise<unknown>) {
  const seen: Seen = { args: [] };
  const exec: Exec = async (command, args, options) => {
    if (command === "git") {
      await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
      return { code: 0 };
    }
    seen.args = [...args];
    const file = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const findings = file("--findings");
    if (findings) seen.findings = JSON.parse(await readFile(findings, "utf8"));
    const state = file("--state");
    if (state) seen.state = JSON.parse(await readFile(state, "utf8"));
    await during?.();
    return { code, ...(options.stdout ? { stdout: printed } : {}) };
  };
  return { exec, seen };
}

export const RUNNER_TOKEN = "runner-token-of-at-least-32-characters";

/**
 * A server with one account whose repository Octo/API is enrolled and
 * whose pull request #7 was reviewed at C1 with two findings (`first` a
 * warning, `second` a critical), made anew for each test of the file that
 * calls this; the fields are read inside a test.
 */
export function fixLoop() {
  let dir = "";
  let n = 0;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ocra-fix-loop-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

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
  const t = {
    s: undefined as unknown as Server,
    accountId: "",
    auth: {} as Record<string, string>,
    repoId: "",
    first: "",
    second: "",
    /** The access each bot token was asked with. */
    access,
  };
  const data = () => scoped(t.s.host.db, t.accountId);
  const ask = async (findings: string[], headers = t.auth) =>
    t.s.call("/api/auto-review/mends", { method: "POST", headers, json: { findings } });

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

  const helpers = {
    data,
    seedReview,
    setLevel: (mend: string, headers = t.auth, checks?: boolean, conflicts?: boolean) =>
      t.s.call(`/api/auto-review/repos/${t.repoId}/mend`, {
        method: "PUT",
        headers,
        json: { mend, checks, conflicts },
      }),
    ask,
    asked: async (findings: string[]) => (await (await ask(findings)).json()) as MendRequestView,
    loop: async () => (await data().list("mendJobs"))[0],
    items: async () =>
      Object.fromEntries((await data().list("mendItems")).map((i) => [i.fingerprint, i])),
    view: async () =>
      (
        await t.s.call("/api/auto-review/mends?platform=github&repo=Octo/API&number=7", {
          headers: t.auth,
        })
      ).json(),
    /** Runs the loop's next round, past the wait that lets clicks share one. */
    runRound: (exec: Exec) =>
      runNextAnswered({
        db: t.s.host.db,
        platforms,
        bots,
        publicUrl: ORIGIN,
        dailyCalls: 1000,
        exec,
        cli: "/opt/ocra/main.js",
        now: () => new Date(Date.now() + 60_000),
      }),
  };

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
    t.s = await graphServer(dir, `mend-${n++}.db`, "off", undefined, {
      bots: { githubApi: GITHUB_COM.api },
      tokens: bots,
      workers: 0,
      runnerToken: RUNNER_TOKEN,
    });
    const me = await t.s.signIn(1);
    t.accountId = me.account.id;
    t.auth = me.auth;
    await data().autoReview.enroll(
      { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
      100,
    );
    t.repoId = (await data().list("reviewRepos"))[0]?.id ?? "";
    [t.first = "", t.second = ""] = await seedReview([
      { fingerprint: "fp-warn", severity: "warning", title: "Unused branch" },
      { fingerprint: "fp-crit" },
    ]);
  });
  afterEach(() => t.s.host.close());
  return Object.assign(t, helpers);
}

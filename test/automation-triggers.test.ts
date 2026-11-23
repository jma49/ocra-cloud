import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hmacHex } from "../src/crypto.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { HOUR } from "../src/time.js";
import { call, db, ORIGIN, request, resetDb, signIn } from "./helpers.js";

// The automation triggers after a pull request is queued, from the GitHub
// App's deliveries (merged, out of draft, approved, a label added, its CI
// failed) and from the hourly run (stale): each rule runs once per pull
// request and event, however often the platform delivers it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SECRET = "automation-triggers-secret";
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const HEAD = "a".repeat(40);
const repository = { id: 11, full_name: "octo/api" };
const pull = (over: Record<string, unknown> = {}) => ({
  head: { sha: HEAD },
  title: "feat: parser",
  user: { login: "mona", type: "User" },
  base: { ref: "main" },
  labels: [{ name: "api" }],
  created_at: "2026-11-02T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  ...over,
});

async function deliver(event: string, payload: unknown, delivery: string = crypto.randomUUID()) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    githubWebhookSecret: SECRET,
  });
  const body = JSON.stringify(payload);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, body)}`,
      },
    }),
    env,
    ctx,
  );
  await res.text();
  await waitOnExecutionContext(ctx);
  return res.status;
}

type Run = { ruleName: string; trigger: string; pull: string; outcome: string };

async function setUp() {
  const me = await signIn(42, "octo");
  await scoped(db, me.account.id).insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", name: "team", when: "blocking", url: SLACK },
  });
  const { channel } = (await added.json()) as { channel: { id: string } };
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text?: string }).text ?? "");
    return new Response("ok");
  });
  const addRule = async (name: string, trigger: string, conditions: Record<string, unknown>) => {
    const res = await call("/api/automations/rules", {
      method: "POST",
      auth: me.auth,
      json: { name, trigger, conditions, actions: [{ kind: "notify", channelId: channel.id }] },
    });
    expect(res.status).toBe(200);
  };
  const runs = async () =>
    ((await (await call("/api/automations/runs", { auth: me.auth })).json()) as { runs: Run[] })
      .runs;
  return { me, addRule, runs, posted };
}

describe("a rule on a pull request's later events", () => {
  it("runs on a merge, leaving draft, an approval and a label added, once each", async () => {
    const { addRule, runs, posted } = await setUp();
    await addRule("merged", "merged", { baseBranches: ["main"] });
    await addRule("ready", "ready_for_review", {});
    await addRule("approved", "approved", { authors: ["MONA"] });
    await addRule("urgent", "labeled", { labels: ["Urgent"] });
    await addRule("never", "merged", { baseBranches: ["release"] });
    const ready = { action: "ready_for_review", number: 7, pull_request: pull(), repository };
    const same = crypto.randomUUID();
    expect(await deliver("pull_request", ready, same)).toBe(202);
    await deliver("pull_request", ready, same);
    // The platform saying it again, in a new delivery, is the same event.
    await deliver("pull_request", ready);
    const labeled = (name: string) => ({
      action: "labeled",
      number: 7,
      label: { name },
      pull_request: pull(),
      repository,
    });
    await deliver("pull_request", labeled("other"));
    await deliver("pull_request", labeled("urgent"));
    await deliver("pull_request", labeled("URGENT"));
    const approval = (id: number, login: string, state = "approved") => ({
      action: "submitted",
      review: { id, state, user: { login, type: "User" }, submitted_at: "2026-11-02T11:00:00Z" },
      pull_request: { ...pull(), number: 7 },
      repository,
    });
    await deliver("pull_request_review", approval(1, "rita", "commented"));
    await deliver("pull_request_review", approval(2, "mona"));
    await deliver("pull_request_review", approval(3, "ocra[bot]"));
    await deliver("pull_request_review", approval(4, "rita"));
    await deliver("pull_request_review", approval(4, "rita"));
    const closed = (merged: boolean) => ({
      action: "closed",
      number: 7,
      pull_request: pull({ merged, merged_at: "2026-11-02T12:00:00Z" }),
      repository,
    });
    await deliver("pull_request", closed(false));
    await deliver("pull_request", closed(true));
    await deliver("pull_request", closed(true));
    const got = await runs();
    expect(got.map((r) => [r.ruleName, r.trigger, r.pull, r.outcome]).sort()).toEqual([
      ["approved", "approved", "octo/api#7", "done"],
      ["merged", "merged", "octo/api#7", "done"],
      ["ready", "ready_for_review", "octo/api#7", "done"],
      ["urgent", "labeled", "octo/api#7", "done"],
    ]);
    expect(posted.filter((t) => t.includes("automation"))).toHaveLength(4);
  });

  it("runs on a failed check suite of another App, once per head", async () => {
    const { addRule, runs } = await setUp();
    await addRule("red", "checks_failed", { authors: ["mona"], title: "feat*" });
    await deliver("pull_request", {
      action: "opened",
      number: 7,
      pull_request: pull(),
      repository,
    });
    const suite = (conclusion: string, head = HEAD) => ({
      action: "completed",
      check_suite: {
        head_sha: head,
        conclusion,
        app: { id: 5 },
        pull_requests: [{ number: 7, head: { sha: head } }],
      },
      repository,
    });
    await deliver("check_suite", suite("success"));
    await deliver("check_suite", suite("failure"));
    await deliver("check_suite", suite("failure"));
    await deliver("check_suite", suite("timed_out", "b".repeat(40)));
    const got = await runs();
    expect(got.map((r) => [r.ruleName, r.trigger, r.outcome])).toEqual([
      ["red", "checks_failed", "done"],
      ["red", "checks_failed", "done"],
    ]);
  });

  it("does not run for a repository the account did not enroll", async () => {
    const { addRule, runs } = await setUp();
    await addRule("merged", "merged", {});
    await deliver("pull_request", {
      action: "closed",
      number: 7,
      pull_request: pull({ merged: true }),
      repository: { id: 12, full_name: "octo/other" },
    });
    expect(await runs()).toEqual([]);
  });
});

describe("a stale rule", () => {
  it("runs once on an open pull request quiet for its hours, again after a new quiet spell", async () => {
    // Imported here so that the triggers' tests above fail on their assertions without it.
    const { runStale } = await import("../src/automations/stale.js");
    const { me, addRule, runs, posted } = await setUp();
    await addRule("quiet day", "stale", { staleHours: 24 });
    await addRule("quiet week", "stale", { staleHours: 168 });
    const opened = (number: number, over: Record<string, unknown> = {}) =>
      deliver("pull_request", { action: "opened", number, pull_request: pull(over), repository });
    await opened(7);
    await opened(8, { draft: true });
    await opened(9);
    await deliver("pull_request", {
      action: "closed",
      number: 9,
      pull_request: pull({ merged: false, closed_at: "2026-11-02T10:00:00Z" }),
      repository,
    });
    const seen = await scoped(db, me.account.id).findOne("pullFlows", { number: 7 });
    if (!seen) throw new Error("no flow");
    const at = (hours: number) => new Date(seen.seenAt.getTime() + hours * HOUR);
    const runner = {
      db,
      bots: undefined,
      platforms: [],
      env,
      out: {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        origin: ORIGIN,
      },
    };
    await runStale(runner, at(23));
    expect(await runs()).toEqual([]);
    await runStale(runner, at(25));
    await runStale(runner, at(26));
    expect((await runs()).map((r) => [r.ruleName, r.pull, r.outcome])).toEqual([
      ["quiet day", "octo/api#7", "done"],
    ]);
    // A new event starts a new quiet spell.
    await deliver("pull_request", {
      action: "edited",
      number: 7,
      pull_request: pull(),
      repository,
    });
    const later = await scoped(db, me.account.id).findOne("pullFlows", { number: 7 });
    if (!later) throw new Error("no flow");
    await runStale(runner, new Date(later.seenAt.getTime() + 25 * HOUR));
    await runStale(runner, new Date(later.seenAt.getTime() + 169 * HOUR));
    expect((await runs()).map((r) => r.ruleName).sort()).toEqual([
      "quiet day",
      "quiet day",
      "quiet week",
    ]);
    expect(posted.filter((t) => t.includes("automation"))).toHaveLength(3);
  });
});

describe("a rule's trigger", () => {
  it("refuses the conditions and actions its event cannot answer, and requires its own", async () => {
    const { me } = await setUp();
    const refused = async (
      trigger: string,
      conditions: Record<string, unknown>,
      actions?: unknown,
    ) => {
      const res = await call("/api/automations/rules", {
        method: "POST",
        auth: me.auth,
        json: {
          name: "x",
          trigger,
          conditions,
          actions: actions ?? [{ kind: "comment", body: "hi" }],
        },
      });
      expect(res.status).toBe(400);
      return ((await res.json()) as { issues: { path: unknown[]; message: string }[] }).issues[0];
    };
    expect(await refused("labeled", {})).toEqual({
      path: ["conditions", "labels"],
      message: "required for a rule on labeled",
    });
    expect((await refused("stale", {}))?.path).toEqual(["conditions", "staleHours"]);
    expect((await refused("stale", { staleHours: 721 }))?.path).toEqual([
      "conditions",
      "staleHours",
    ]);
    expect((await refused("checks_failed", { labels: ["a"] }))?.path).toEqual([
      "conditions",
      "labels",
    ]);
    expect((await refused("merged", { critical: true }))?.path).toEqual(["conditions", "critical"]);
    expect((await refused("queued", { staleHours: 2 }))?.path).toEqual([
      "conditions",
      "staleHours",
    ]);
    expect((await refused("approved", {}, [{ kind: "skip_review" }]))?.path).toEqual([
      "actions",
      0,
    ]);
  });
});

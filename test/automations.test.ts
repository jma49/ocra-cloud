import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionsHold, globMatch } from "../src/automations/rules.js";
import { AUTOMATION_RUN_DAYS, enforceRetention } from "../src/db/retention.js";
import { scoped } from "../src/db/scoped.js";
import { githubActions } from "../src/platforms/github-actions.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { DAY } from "../src/time.js";
import { upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

// The account's automation rules: checked when saved, seen and changed by
// that account only, tried by a dry run, and run on a pull request's
// uploaded review once, with what each action did kept in the run log.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const HEAD = "a".repeat(40);

type Auth = Record<string, string>;
const addRule = (auth: Auth, json: Record<string, unknown>) =>
  call("/api/automations/rules", { method: "POST", auth, json });
const rule = (over: Record<string, unknown> = {}) => ({
  name: "label risky",
  trigger: "reviewed",
  conditions: { critical: true },
  actions: [{ kind: "add_labels", labels: ["needs-attention"] }],
  ...over,
});
const dryRun = (auth: Auth, json: Record<string, unknown>) =>
  call("/api/automations/dry-run", { method: "POST", auth, json });

describe("a title pattern", () => {
  it("matches with * and ?, case-folded, and nothing else", () => {
    expect(globMatch("WIP*", "wip: parser")).toBe(true);
    expect(globMatch("*[skip ci]*", "fix it [skip ci] now")).toBe(true);
    expect(globMatch("v?.0", "v1.0")).toBe(true);
    expect(globMatch("v?.0", "v10.0")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("fix", "fix it")).toBe(false);
  });

  it("takes time bounded by its length on a pattern that defeats backtracking", () => {
    const started = Date.now();
    expect(globMatch(`${"*a".repeat(100)}b`, "a".repeat(400))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("holds only for the facts the event carried", () => {
    const c = { authors: ["Dependabot[bot]"], labels: ["deps"] };
    expect(conditionsHold(c, { author: "dependabot[bot]", labels: ["DEPS", "x"] })).toBe(true);
    expect(conditionsHold(c, { author: "dependabot[bot]" })).toBe(false);
    expect(conditionsHold({}, {})).toBe(true);
  });
});

describe("the rules", () => {
  it("are added, listed, replaced and removed", async () => {
    const { auth } = await signIn(1, "octo");
    const res = await addRule(auth, rule());
    expect(res.status).toBe(200);
    const { rule: added } = (await res.json()) as { rule: { id: string } };
    // A Worker has no ocra bot: the label is stored but cannot be written here.
    expect(added).toMatchObject({ name: "label risky", enabled: true, runsHere: false });
    const put = await call(`/api/automations/rules/${added.id}`, {
      method: "PUT",
      auth,
      json: rule({
        name: "skip docs",
        trigger: "queued",
        conditions: { title: "docs:*" },
        actions: [{ kind: "skip_review" }],
      }),
    });
    expect(await put.json()).toMatchObject({
      rule: { name: "skip docs", trigger: "queued", runsHere: true },
    });
    const listed = (await (await call("/api/automations/rules", { auth })).json()) as {
      rules: unknown[];
    };
    expect(listed.rules).toHaveLength(1);
    const removed = await call(`/api/automations/rules/${added.id}`, { method: "DELETE", auth });
    expect(await removed.json()).toEqual({ removed: true });
  });

  it("refuse a body that cannot run as written", async () => {
    const { auth } = await signIn(1, "octo");
    const other = await signIn(2, "hubot");
    const channel = await call("/api/notifications/channels", {
      method: "POST",
      auth: other.auth,
      json: { kind: "slack", name: "theirs", when: "every", url: SLACK },
    });
    const { channel: theirs } = (await channel.json()) as { channel: { id: string } };
    for (const bad of [
      rule({ conditions: { authors: ["octo"] } }),
      rule({ actions: [{ kind: "skip_review" }] }),
      rule({ trigger: "queued", conditions: { critical: true } }),
      rule({ actions: [{ kind: "add_labels", labels: ["a,b"] }] }),
      rule({ actions: [{ kind: "request_reviewers", reviewers: ["@octo; rm"] }] }),
      rule({ actions: [{ kind: "comment", body: "\u0000\u0007" }] }),
      rule({ actions: [{ kind: "comment", body: "x".repeat(2001) }] }),
      rule({ actions: [] }),
      rule({ conditions: { repoIds: ["not-enrolled"] } }),
      rule({ actions: [{ kind: "notify", channelId: theirs.id }] }),
      rule({ conditions: { critical: true, regex: ".*" } }),
    ]) {
      const res = await addRule(auth, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await (await call("/api/automations/rules", { auth })).json()).toEqual({ rules: [] });
  });

  it("are at most fifty an account", async () => {
    const { auth, account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    for (let i = 0; i < 50; i++) await d.insert("automationRules", rows.automationRules(`r${i}`));
    const res = await addRule(auth, rule());
    expect(res.status).toBe(400);
    expect(await d.count("automationRules")).toBe(50);
  });

  it("are another account's to see, change and try only for that account", async () => {
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    const res = await addRule(a.auth, rule());
    const { rule: added } = (await res.json()) as { rule: { id: string } };
    const put = await call(`/api/automations/rules/${added.id}`, {
      method: "PUT",
      auth: b.auth,
      json: rule({ name: "taken" }),
    });
    expect(put.status).toBe(404);
    const del = await call(`/api/automations/rules/${added.id}`, {
      method: "DELETE",
      auth: b.auth,
    });
    expect(await del.json()).toEqual({ removed: false });
    expect(await (await call("/api/automations/rules", { auth: b.auth })).json()).toEqual({
      rules: [],
    });
    const tried = await dryRun(b.auth, { trigger: "reviewed", pull: { critical: true } });
    expect(await tried.json()).toEqual({ matches: [], skipped: [] });
    expect(
      (await call("/api/automations/rules", { auth: (await signInCli(1, "octo")).auth })).status,
    ).toBe(403);
  });
});

describe("a dry run", () => {
  it("names the enabled rules whose conditions hold, and does nothing", async () => {
    const { auth } = await signIn(1, "octo");
    await addRule(auth, rule({ name: "critical" }));
    await addRule(auth, rule({ name: "off", enabled: false }));
    await addRule(
      auth,
      rule({
        name: "bots",
        trigger: "queued",
        conditions: { authors: ["renovate[bot]"], title: "chore(deps)*" },
        actions: [{ kind: "skip_review" }],
      }),
    );
    const reviewed = await dryRun(auth, { trigger: "reviewed", pull: { critical: true } });
    expect(await reviewed.json()).toMatchObject({
      matches: [{ name: "critical", actions: ["add_labels"] }],
    });
    const queued = await dryRun(auth, {
      trigger: "queued",
      pull: { author: "Renovate[bot]", title: "chore(deps): bump zod" },
    });
    expect(await queued.json()).toMatchObject({ matches: [{ name: "bots" }] });
    const other = await dryRun(auth, { trigger: "queued", pull: { author: "octo", title: "x" } });
    expect(await other.json()).toEqual({ matches: [], skipped: [] });
    expect(await (await call("/api/automations/runs", { auth })).json()).toEqual({ runs: [] });
  });
});

describe("a pull request's uploaded review", () => {
  it("runs each matching rule once, and keeps what each action did", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const added = await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "slack", name: "team", when: "blocking", url: SLACK },
    });
    const { channel } = (await added.json()) as { channel: { id: string } };
    await addRule(
      web.auth,
      rule({
        actions: [
          { kind: "notify", channelId: channel.id },
          { kind: "comment", body: "Please look" },
        ],
      }),
    );
    await addRule(web.auth, rule({ name: "clean only", conditions: { critical: false } }));
    const posted: { url: string; text: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const body = (await req.json()) as { text?: string };
      posted.push({ url: req.url, text: body.text ?? "" });
      return new Response("ok");
    });
    const json = {
      ...upload("run-pr", []),
      pullRequest: { repository: "https://github.com/octo/api", number: 7, headSha: HEAD },
    };
    expect((await call("/api/reviews", { method: "POST", auth: cli.auth, json })).status).toBe(200);
    // A retried upload is the same review: no second run.
    await call("/api/reviews", { method: "POST", auth: cli.auth, json });
    const automation = posted.filter((p) => p.text.includes("automation"));
    expect(automation).toHaveLength(1);
    expect(automation[0]?.text).toContain(
      '"label risky" ran on <https://github.com/octo/api/pull/7|octo/api#7>',
    );
    const { runs } = (await (await call("/api/automations/runs", { auth: web.auth })).json()) as {
      runs: unknown[];
    };
    // The repository is not one the account enrolled: the bot writes nothing there.
    expect(runs).toEqual([
      expect.objectContaining({
        ruleName: "label risky",
        pull: "octo/api#7",
        outcome: "partial",
        actions: [
          { kind: "notify", outcome: "done" },
          { kind: "comment", outcome: "not_enrolled" },
        ],
      }),
    ]);
  });
});

describe("the run log", () => {
  it("keeps a run for a month", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    await d.insert("automationRuns", {
      ...rows.automationRuns("old"),
      createdAt: ago(AUTOMATION_RUN_DAYS + 1),
    });
    await d.insert("automationRuns", {
      ...rows.automationRuns("new"),
      createdAt: ago(AUTOMATION_RUN_DAYS - 1),
    });
    await enforceRetention(db, now);
    expect((await d.list("automationRuns")).map((r) => r.id)).toEqual(["new"]);
  });
});

describe("GitHub's pull request actions for a rule", () => {
  it("add labels and ask reviewers on the pull request, a refusal answered as one", async () => {
    const sent: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      sent.push({ method: req.method, url: req.url, body: await req.json() });
      return new Response("{}", { status: req.url.endsWith("requested_reviewers") ? 422 : 200 });
    });
    const actions = githubActions(GITHUB_COM);
    expect(await actions.addLabels("t", "octo/api", 7, ["a", "b"])).toBe("done");
    expect(await actions.requestReviewers("t", "octo/api", 7, ["alice"])).toBe("refused");
    expect(sent).toEqual([
      {
        method: "POST",
        url: "https://api.github.com/repos/octo/api/issues/7/labels",
        body: { labels: ["a", "b"] },
      },
      {
        method: "POST",
        url: "https://api.github.com/repos/octo/api/pulls/7/requested_reviewers",
        body: { reviewers: ["alice"] },
      },
    ]);
  });
});

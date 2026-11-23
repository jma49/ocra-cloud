import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAutomations } from "../src/automations/retry.js";
import { CallBudget, withCalls } from "../src/calls.js";
import * as schema from "../src/db/schema.js";
import { botTokens } from "../src/platforms/bot-tokens.js";
import { platformsOf } from "../src/platforms/registry.js";
import type { AutomationAction } from "../src/shared/index.js";
import { db, ORIGIN, resetDb, signIn } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// An automation's retry inside a budget of calls (the Worker's hourly run):
// an attempt the budget cut short is given back uncounted and due at once,
// keeping the writes the platform answered, so each is sent once.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MR = `${GITLAB}/api/v4/projects/${encodeURIComponent("group/api")}/merge_requests/3`;
const LABEL: AutomationAction = { kind: "add_labels", labels: ["needs-review"] };
const comment = (body: string): AutomationAction => ({ kind: "comment", body });
const ACTIONS = [LABEL, comment("one"), comment("two"), comment("three"), comment("four")];

const runner = () => ({
  db,
  bots: botTokens({ githubApi: "https://api.github.com", gitlabBotToken: "glbot" }),
  platforms: platformsOf(env, ORIGIN),
});

describe("an automation's retry the run's calls cut short", () => {
  it("keeps what was answered, counts no attempt and sends the rest once", async () => {
    const me = await signIn(1, "octo");
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos("repo"),
      accountId: me.account.id,
      platform: "gitlab",
      host: new URL(GITLAB).host,
      fullName: "group/api",
    });
    await db.insert(schema.automationRuns).values({
      ...rows.automationRuns("run"),
      accountId: me.account.id,
      outcome: "failed",
      attempts: 1,
      actions: ACTIONS.map((a) => ({ kind: a.kind, outcome: "unreached" as const })),
      retry: {
        reviewRepoId: "repo",
        number: 3,
        actions: ACTIONS.map((action, index) => ({ index, action })),
      },
      retryAt: new Date(Date.now() - 60_000),
    });
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (!req.url.startsWith(MR)) return new Response(null, { status: 404 });
      sent.push(`${req.method} ${req.url.slice(MR.length)} ${await req.text()}`);
      return Response.json({});
    });
    const run = async () => (await db.select().from(schema.automationRuns))[0];

    // Too few calls left for an attempt: none is claimed.
    const few = new CallBudget(3);
    expect(await withCalls(few, () => retryAutomations(runner(), undefined, few))).toBe(0);
    expect(await run()).toMatchObject({ attempts: 1 });
    expect(sent).toEqual([]);

    const calls = new CallBudget(4);
    expect(await withCalls(calls, () => retryAutomations(runner(), undefined, calls))).toBe(1);
    expect(sent).toHaveLength(4);
    const cut = await run();
    expect(cut).toMatchObject({
      outcome: "partial",
      attempts: 1,
      actions: [
        { kind: "add_labels", outcome: "done" },
        { kind: "comment", outcome: "done" },
        { kind: "comment", outcome: "done" },
        { kind: "comment", outcome: "done" },
        { kind: "comment", outcome: "unreached" },
      ],
      retry: { reviewRepoId: "repo", number: 3, actions: [{ index: 4, action: ACTIONS[4] }] },
    });
    expect(cut?.retryAt?.getTime()).toBeLessThanOrEqual(Date.now());

    expect(await retryAutomations(runner())).toBe(1);
    expect(await run()).toMatchObject({ outcome: "done", attempts: 2, retry: null, retryAt: null });
    expect(sent).toHaveLength(5);
    expect(new Set(sent).size).toBe(5);
    expect(sent[4]).toContain("four");
  });
});

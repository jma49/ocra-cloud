import { beforeEach, describe, expect, it } from "vitest";
import { type PickInput, pickReviewers } from "../src/automations/assign.js";
import { scoped } from "../src/db/scoped.js";
import type { AssignReviewers, SuggestedReviewer } from "../src/shared/index.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// An assign_reviewers action: who it chooses by each strategy, its rule's
// claim on a pull request and its round robin's cursor, both held by the
// database, and the rules it may be saved in.

beforeEach(resetDb);

const suggestion = (login: string, score: number): SuggestedReviewer => ({
  login,
  reasons: ["recent_reviewer"],
  score,
  ownedFiles: 0,
  recentReviews: score,
  reviewedPaths: null,
  load: 0,
  alreadyRequested: false,
});

const pick = (action: Omit<AssignReviewers, "kind">, over: Partial<PickInput> = {}) =>
  pickReviewers({
    action: { kind: "assign_reviewers", ...action },
    author: "octo",
    requested: [],
    owners: [],
    suggestions: [],
    load: [],
    cursor: 0,
    ...over,
  });

describe("choosing reviewers", () => {
  it("takes the best suggestions, fewer by those already asked", () => {
    const suggestions = [suggestion("mona", 9), suggestion("hubot", 5), suggestion("lisa", 2)];
    expect(pick({ strategy: "suggested", count: 2 }, { suggestions }).logins).toEqual([
      "mona",
      "hubot",
    ]);
    expect(
      pick({ strategy: "suggested", count: 2 }, { suggestions, requested: ["Mona"] }).logins,
    ).toEqual(["hubot"]);
    expect(
      pick({ strategy: "suggested", count: 2 }, { suggestions, requested: ["a", "b"] }).logins,
    ).toEqual([]);
  });

  it("puts code owners first when asked", () => {
    const suggestions = [suggestion("mona", 9), suggestion("hubot", 5), suggestion("lisa", 2)];
    const owners = [
      [{ name: "Lisa", kind: "user" as const }],
      [{ name: "core", kind: "team" as const }],
    ];
    const base = { strategy: "suggested" as const, count: 2 };
    expect(pick(base, { suggestions, owners }).logins).toEqual(["mona", "hubot"]);
    expect(pick({ ...base, codeOwnersFirst: true }, { suggestions, owners }).logins).toEqual([
      "lisa",
      "mona",
    ]);
  });

  it("goes round the list from the cursor, past the author, bots and those asked", () => {
    const logins = ["octo", "mona", "ci[bot]", "hubot", "lisa"];
    const rr = { strategy: "round_robin" as const, count: 2, logins };
    expect(pick(rr, { cursor: 0 })).toEqual({ logins: ["mona", "hubot"], advance: 4 });
    expect(pick(rr, { cursor: 4 })).toEqual({ logins: ["lisa", "mona"], advance: 3 });
    // The cursor is read modulo the list, which may have changed since.
    expect(pick(rr, { cursor: 9 })).toEqual({ logins: ["lisa", "mona"], advance: 3 });
    expect(pick(rr, { cursor: 0, requested: ["mona"] })).toEqual({
      logins: ["hubot"],
      advance: 4,
    });
    expect(pick({ ...rr, logins: ["octo", "ci[bot]"] })).toEqual({ logins: [], advance: 0 });
  });

  it("takes the least loaded of the list, unread loads last, ties in list order", () => {
    const ll = {
      strategy: "least_loaded" as const,
      count: 2,
      logins: ["mona", "hubot", "lisa", "kim"],
    };
    expect(pick(ll, { load: [3, null, 1, 3] })).toEqual({ logins: ["lisa", "mona"], advance: 0 });
  });
});

describe("a rule's assignment", () => {
  it("claims a pull request once, and gives the claim up for a later event", async () => {
    const { account } = await signIn(1, "octo");
    const d = scoped(db, account.id);
    await d.insert("reviewRepos", rows.reviewRepos("repo"));
    const first = await d.automations.claimAssignment("rule", "repo", 7);
    expect(first).toEqual(expect.any(String));
    expect(await d.automations.claimAssignment("rule", "repo", 7)).toBeUndefined();
    expect(await d.automations.claimAssignment("other", "repo", 7)).toEqual(expect.any(String));
    expect(await d.automations.claimAssignment("rule", "repo", 8)).toEqual(expect.any(String));
    await d.automations.settleAssignment(first ?? "", null);
    const again = await d.automations.claimAssignment("rule", "repo", 7);
    expect(again).toEqual(expect.any(String));
    await d.automations.settleAssignment(again ?? "", ["mona"]);
    expect(await d.get("automationAssignments", again ?? "")).toMatchObject({ logins: ["mona"] });
  });

  it("moves a round robin's cursor only from where it was read", async () => {
    const { account } = await signIn(1, "octo");
    const other = await signIn(2, "hubot");
    const d = scoped(db, account.id);
    await d.insert("automationRules", rows.automationRules("rr"));
    expect(await d.automations.moveCursor("rr", 0, 2)).toBe(true);
    expect(await d.automations.moveCursor("rr", 0, 1)).toBe(false);
    expect(await scoped(db, other.account.id).automations.moveCursor("rr", 2, 5)).toBe(false);
    expect(await d.get("automationRules", "rr")).toMatchObject({ assignCursor: 2 });
  });
});

describe("a rule that assigns reviewers", () => {
  const save = async (auth: Record<string, string>, actions: unknown[], trigger = "queued") =>
    call("/api/automations/rules", {
      method: "POST",
      auth,
      json: { name: "assign", trigger, conditions: {}, actions },
    });

  it("is saved with a strategy, a count and, for a list, its logins", async () => {
    const { auth } = await signIn(1, "octo");
    const ok = [
      { kind: "assign_reviewers", strategy: "suggested", count: 2, codeOwnersFirst: true },
      { kind: "assign_reviewers", strategy: "round_robin", count: 1, logins: ["mona", "hubot"] },
      { kind: "assign_reviewers", strategy: "least_loaded", count: 5, logins: ["mona"] },
    ];
    for (const action of ok) {
      const res = await save(auth, [action]);
      expect(res.status, JSON.stringify(action)).toBe(200);
      expect(((await res.json()) as { rule: { actions: unknown[] } }).rule.actions).toEqual([
        action,
      ]);
    }
  });

  it("is refused when it cannot run as written", async () => {
    const { auth } = await signIn(1, "octo");
    const a = { kind: "assign_reviewers", strategy: "suggested", count: 1 };
    for (const [actions, trigger] of [
      [[{ ...a, count: 0 }]],
      [[{ ...a, count: 6 }]],
      [[{ ...a, count: 1.5 }]],
      [[{ ...a, strategy: "random" }]],
      [[{ ...a, logins: ["mona"] }]],
      [[{ ...a, strategy: "round_robin" }]],
      [[{ ...a, strategy: "least_loaded", logins: ["@mona; rm"] }]],
      [[{ ...a, strategy: "round_robin", logins: Array.from({ length: 21 }, (_, i) => `u${i}`) }]],
      [[a, a]],
      [[a], "reviewed"],
    ] as [unknown[], string?][]) {
      const res = await save(auth, actions, trigger);
      expect(res.status, JSON.stringify(actions)).toBe(400);
    }
  });
});

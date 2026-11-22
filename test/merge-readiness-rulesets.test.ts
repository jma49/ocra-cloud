import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers.js";
import { signInWithGithub } from "./platform-fakes.js";
import {
  byKind,
  type GithubPull,
  githubPull,
  HEAD,
  NOT_PROTECTED,
  OLD,
  PROTECTION,
  REFUSED,
  RULESETS_CALL,
  readiness,
  ruleOf,
  run,
} from "./readiness-fakes.js";

// GitHub rulesets on the base branch, read alongside the classic branch
// protection rule: the strictest of the two wins, and what a part read
// requires is a floor while the rest is not known.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const read = async (p: GithubPull) => {
  const calls = githubPull(p);
  const a = await signInWithGithub();
  const view = await readiness(a.send, "platform=github&repo=octo/api&number=7");
  return { calls, view, items: byKind(view) };
};

const REVIEWS = ruleOf("pull_request", {
  required_approving_review_count: 2,
  require_code_owner_review: true,
  dismiss_stale_reviews_on_push: true,
  required_review_thread_resolution: true,
  require_last_push_approval: false,
});
const CHECKS = ruleOf("required_status_checks", {
  required_status_checks: [{ context: "ci" }, { context: "deploy", integration_id: 1 }],
  strict_required_status_checks_policy: false,
});

describe("merge readiness from GitHub rulesets", () => {
  it("takes a repository protected only by rulesets at the rulesets' word", async () => {
    const { calls, view, items } = await read({
      rule: null,
      protection: NOT_PROTECTED,
      decision: null,
      files: ["src/db/query.ts"],
      reviews: [
        { login: "lead", oid: HEAD },
        { login: "dba", oid: OLD },
      ],
      threads: [false],
      contexts: [run("ci", "COMPLETED", "SUCCESS", false)],
      rulesets: {
        status: 200,
        body: [REVIEWS, CHECKS, ruleOf("merge_queue"), ruleOf("deletion"), ruleOf("merge_queue")],
      },
    });
    expect(calls).toEqual(["POST https://api.github.com/graphql", PROTECTION, RULESETS_CALL]);
    expect(items.approvals).toEqual([
      "unmet",
      "1 of 2 required approvals; 1 approval of an earlier head no longer count",
    ]);
    expect(items.code_owners).toEqual(["unmet", "0 of 1 owner group approved; waiting on dba"]);
    expect(view.codeOwners[0]).toMatchObject({ owners: ["dba"], required: true });
    expect(items.required_checks).toEqual(["pending", "Waiting for deploy"]);
    expect(items.threads).toEqual([
      "unmet",
      "1 unresolved thread; the branch rules require resolving them",
    ]);
    expect(view.otherRules).toEqual(["merge_queue"]);
  });

  it("lets the strictest of the branch rule and the rulesets win", async () => {
    const stricter = await read({
      reviews: [{ login: "lead", oid: HEAD }],
      contexts: [],
      rulesets: {
        status: 200,
        body: [
          ruleOf("pull_request", { required_approving_review_count: 3 }),
          ruleOf("required_status_checks", { required_status_checks: [{ context: "e2e" }] }),
        ],
      },
    });
    expect(stricter.calls).toEqual(["POST https://api.github.com/graphql", RULESETS_CALL]);
    expect(stricter.items.approvals).toEqual(["unmet", "1 of 3 required approvals"]);
    expect(stricter.items.required_checks).toEqual(["pending", "Waiting for ci, lint, e2e"]);
    vi.restoreAllMocks();
    const laxer = await read({
      reviews: [{ login: "lead", oid: HEAD }],
      rulesets: {
        status: 200,
        body: [ruleOf("pull_request", { required_approving_review_count: 1 })],
      },
    });
    expect(laxer.items.approvals).toEqual(["unmet", "1 of 2 required approvals"]);
  });

  it("holds a ruleset's requirement as a floor while the branch rule is not readable", async () => {
    const { items } = await read({
      ruleRefused: true,
      protection: REFUSED,
      decision: null,
      reviews: [{ login: "lead", oid: HEAD }],
      contexts: [],
      rulesets: { status: 200, body: [REVIEWS, CHECKS] },
    });
    expect(items.approvals).toEqual([
      "unmet",
      "1 of at least 2 required approvals; branch rule not readable",
    ]);
    expect(items.required_checks).toEqual(["pending", "Waiting for ci, deploy"]);
  });

  it("does not take a full page of rules for all of them", async () => {
    const { items } = await read({
      rule: null,
      protection: NOT_PROTECTED,
      decision: null,
      rulesets: { status: 200, body: Array.from({ length: 100 }, () => ruleOf("deletion")) },
    });
    expect(items.approvals).toEqual([
      "unknown",
      "0 approvals; more rulesets than one reading lists",
    ]);
  });

  it("reads as before when the rulesets are refused or not found", async () => {
    for (const rulesets of [REFUSED, { status: 404, body: { message: "Not Found" } }]) {
      vi.restoreAllMocks();
      const { view, items } = await read({
        rule: null,
        protection: NOT_PROTECTED,
        decision: null,
        contexts: [],
        rulesets,
      });
      expect(items.approvals).toEqual(["met", "No approval is required (0 given)"]);
      expect(items.required_checks).toEqual(["met", "No check is required"]);
      expect(view.otherRules).toEqual([]);
    }
  });
});

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import { apiTokenByHash } from "../src/db/api-tokens.js";
import { accountsWithRules } from "../src/db/automations.js";
import { claimInboundRetry } from "../src/db/inbound-events.js";
import { recoverJobs } from "../src/db/job-recovery.js";
import { enforceRetention } from "../src/db/retention.js";
import { accountTables } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { type CallInit, call, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";

// Audit D3: every scoped read finds the account's rows through an index,
// never by scanning the table across all accounts.

type Captured = { sql: string; params: unknown[] };

/** A D1 binding that records each statement it runs, with its parameters. */
function recording(seen: Captured[]): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare")
        return (q: string) => {
          const entry: Captured = { sql: q, params: [] };
          seen.push(entry);
          const stmt = target.prepare(q);
          return new Proxy(stmt, {
            get(s, p) {
              if (p === "bind")
                return (...args: unknown[]) => {
                  entry.params = args;
                  return s.bind(...args);
                };
              const v = Reflect.get(s, p);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function plan(q: Captured): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
    .bind(...q.params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const names = Object.keys(accountTables) as (keyof typeof accountTables)[];
const TABLE: Record<string, string> = {
  sessions: "sessions",
  apiTokens: "api_tokens",
  providerKeys: "provider_keys",
  reviews: "reviews",
  auditEvents: "audit_events",
  gatewayCalls: "gateway_calls",
  preferences: "preferences",
  preferenceVersions: "preference_versions",
  findings: "findings",
  accountMemory: "account_memory",
  usageCounters: "usage_counters",
  repositories: "repositories",
  budgets: "budgets",
  platformLinks: "platform_links",
  pullViews: "pull_views",
  pullSeen: "pull_seen",
  pullFileViews: "pull_file_views",
  graphRepos: "graph_repos",
  graphBuilds: "graph_builds",
  graphChunks: "graph_chunks",
  pullImpacts: "pull_impacts",
  reviewRepos: "review_repos",
  autoEnrollInstallations: "auto_enroll_installations",
  autoEnrollGroups: "auto_enroll_groups",
  reviewJobs: "review_jobs",
  notifyChannels: "notify_channels",
  notifySends: "notify_sends",
  notifyHeld: "notify_held",
  notifyDeliveries: "notify_deliveries",
  closedPulls: "closed_pulls",
  pullFlows: "pull_flows",
  pullIndex: "pull_index",
  pullReviews: "pull_reviews",
  reviewThreads: "review_threads",
  findingThreads: "finding_threads",
  pullPaths: "pull_paths",
  reviewRequests: "review_requests",
  reviewTeams: "review_teams",
  reviewTargets: "review_targets",
  replyJobs: "reply_jobs",
  generateJobs: "generate_jobs",
  learnJobs: "learn_jobs",
  pullCommands: "pull_commands",
  pausedPulls: "paused_pulls",
  reviewWalkthroughs: "review_walkthroughs",
  automationRules: "automation_rules",
  automationRuns: "automation_runs",
  automationAssignments: "automation_assignments",
  mergeChecks: "merge_checks",
  mergeCheckRuns: "merge_check_runs",
  mergeIntents: "merge_intents",
  stackMerges: "stack_merges",
  stackMergeLayers: "stack_merge_layers",
  reviewChatMessages: "review_chat_messages",
  findingIssues: "finding_issues",
  liveRuns: "live_runs",
  liveEvents: "live_events",
  liveGrants: "live_grants",
  liveComments: "live_comments",
};

describe("query plans", () => {
  it("finds a personal API token by its hash through the unique index", async () => {
    const seen: Captured[] = [];
    await apiTokenByHash(drizzle(recording(seen)), "h".repeat(64));
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(/SEARCH api_tokens USING INDEX api_tokens_token_hash_unique/);
    expect(p).not.toMatch(/SCAN api_tokens/);
  });

  it("the stale sweep finds its accounts, quiet pull requests and runs through indexes", async () => {
    const seen: Captured[] = [];
    const recorded = drizzle(recording(seen));
    await accountsWithRules(recorded, "stale");
    const d = scoped(recorded, "acct");
    await d.pullFlows.quiet(new Date(0), new Date(1), 10);
    await d.automations.ranOn(["r1"], ["stale:x#1@0"]);
    const [accounts, quiet, ran] = await Promise.all(seen.map(plan));
    expect(accounts).toMatch(
      /SEARCH automation_rules USING (COVERING )?INDEX automation_rules_trigger/,
    );
    expect(quiet).toMatch(
      /SEARCH t USING INDEX pull_flows_account_seen|SEARCH pull_flows USING INDEX pull_flows_account_seen/,
    );
    expect(ran).toMatch(
      /SEARCH automation_runs USING (COVERING )?INDEX automation_runs_rule_event/,
    );
    for (const p of [accounts, quiet, ran]) expect(p).not.toMatch(/\bSCAN\b/);
  });

  it.each(names)("list(%s) searches an index on account_id", async (name) => {
    const seen: Captured[] = [];
    await scoped(drizzle(recording(seen)), "acct").list(name);
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(new RegExp(`SEARCH ${TABLE[name]} USING (COVERING )?INDEX`));
    expect(p).not.toMatch(/\bSCAN\b/);
  });

  it.each(["gatewayCalls", "auditEvents", "reviews", "preferenceVersions"] as const)(
    "countSince and listSince(%s) use the (account_id, created_at) index",
    async (name) => {
      const seen: Captured[] = [];
      const d = scoped(drizzle(recording(seen)), "acct");
      await d.countSince(name, new Date(0));
      await d.listSince(name, new Date(0), 10);
      for (const q of seen) {
        const p = await plan(q);
        expect(p).toMatch(
          new RegExp(`SEARCH ${TABLE[name]} USING (COVERING )?INDEX \\w+_account_created`),
        );
        expect(p).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
      }
    },
  );

  it("an audit page walks an index in (created_at, id) order, of all kinds or one", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    const after = { createdAt: new Date(5), id: "x" };
    const range = { since: new Date(0), until: new Date(9) };
    await d.audit.page({}, 50);
    await d.audit.page(range, 50, after);
    await d.audit.page({ kind: "key.saved" }, 50);
    await d.audit.page({ kind: "key.saved", ...range }, 50, after);
    expect(seen).toHaveLength(4);
    for (const [i, q] of seen.entries()) {
      const p = await plan(q);
      const index = i < 2 ? "audit_events_account_created" : "audit_events_account_kind_created";
      expect(p, q.sql).toMatch(new RegExp(`SEARCH audit_events USING INDEX ${index} `));
      expect(p, q.sql).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
    }
  });

  it("find, count, listNewest and liveSessions search an index on account_id (#34)", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.find("providerKeys", { provider: "openai" });
    await d.findOne("accountMemory", { repoHash: "h" });
    await d.count("findings");
    await d.findOne("preferences", {});
    await d.listNewest("preferenceVersions", 1);
    await d.liveSessions(new Date());
    expect(seen).toHaveLength(6);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(/SEARCH \w+ USING (COVERING )?(INDEX|PRIMARY KEY)/);
      expect(p, q.sql).not.toMatch(/\bSCAN\b/);
    }
  });

  it("the memory list walks an index in created_at order and stops at its limit (#96)", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.listNewest("accountMemory", 500);
    await d.listNewest("accountMemory", 500, { repoHash: "h" });
    const [all, repo] = await Promise.all(seen.map(plan));
    expect(all).toMatch(/SEARCH account_memory USING INDEX account_memory_account_created/);
    expect(repo).toMatch(/SEARCH account_memory USING INDEX account_memory_repo_created/);
    for (const p of [all, repo]) expect(p).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
  });

  it("the findings inbox walks the (account_id, status, created_at, id) index for a status", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.inbox({ status: "open" }, 50);
    await d.findingStatusCounts();
    const [list, counts] = await Promise.all(seen.map(plan));
    expect(list).toMatch(/SEARCH findings USING INDEX findings_account_status_created/);
    expect(list).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
    expect(counts).toMatch(
      /SEARCH findings USING (COVERING )?INDEX findings_account_status_created/,
    );
  });

  it("the inbox reads each listed pull's newest verdict through (account_id, pr_number, created_at)", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.pullViews.verdicts([{ repo: "https://github.com/octo/api", number: 7 }]);
    expect(seen).toHaveLength(1);
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(/SEARCH reviews USING INDEX reviews_account_pull/);
    expect(p).not.toMatch(/SCAN reviews|TEMP B-TREE/);
  });

  it("the inbox reads its read marks through the (account_id, platform, repo, number) index", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.pullSeen.markers([{ platform: "github", repo: "octo/api", number: 7 }]);
    expect(seen).toHaveLength(1);
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(/SEARCH s USING INDEX pull_seen_account_pull/);
    expect(p).not.toMatch(/SCAN s\b|SCAN pull_seen/);
  });

  it("a merge request's viewed files are read, ticked and unticked through the file index", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    const pull = { platform: "gitlab" as const, repo: "group/api", number: 3 };
    await d.pullFileViews.versions(pull);
    await d.pullFileViews.unmark(pull, ["app.rb"]);
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH pull_file_views USING (COVERING )?INDEX pull_file_views_file/,
      );
      expect(p, q.sql).not.toMatch(/SCAN pull_file_views/);
    }
  });

  it("the inbox sets and reads its baseline by the account's primary key", async () => {
    const seen: Captured[] = [];
    await scoped(drizzle(recording(seen)), "acct").pullSeen.baseline(null);
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      const p = await plan(q);
      expect(p).toMatch(/SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)/);
      expect(p).not.toMatch(/SCAN accounts/);
    }
  });

  it("the daily digest reads reviews and findings through their account indexes", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.notify.digestOf(new Date(0), new Date(), true);
    await d.notify.digesting(["every"]);
    await d.notify.listening(["every"]);
    expect(seen).toHaveLength(4);
    const [reviews, findings, ...channels] = await Promise.all(seen.map(plan));
    expect(reviews).toMatch(/SEARCH reviews USING INDEX reviews_account_created/);
    expect(findings).toMatch(/SEARCH findings USING INDEX findings_account_status_created/);
    for (const p of [reviews, findings, ...channels]) expect(p).not.toMatch(/\bSCAN\b/);
  });

  it("a review's conversation is read by (account_id, review_id, created_at) and its cascade by review_id", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.chat.latest("r", 20);
    await d.chat.add("r", "user", "q", new Date(), 99);
    const [latest, add] = await Promise.all(seen.map(plan));
    expect(latest).toMatch(
      /SEARCH review_chat_messages USING INDEX review_chat_messages_account_review/,
    );
    expect(latest).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
    expect(add).toMatch(
      /SEARCH review_chat_messages USING COVERING INDEX review_chat_messages_account_review/,
    );
    expect(add).not.toMatch(/\bSCAN\b/);
    const cascade = await plan({
      sql: "SELECT id FROM review_chat_messages WHERE review_id = ?",
      params: ["r"],
    });
    expect(cascade).toMatch(
      /SEARCH review_chat_messages USING (COVERING )?INDEX review_chat_messages_review/,
    );
  });

  it("the search reads each table through its account index, newest first, without a sort", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.search.reviews({ text: "octo/api" }, 5);
    await d.search.reviews({ text: "12" }, 5);
    await d.search.reviews({ repo: "octo/api", number: 12 }, 5);
    await d.search.findings("refund", 5);
    await d.search.repositories("octo", 5);
    expect(seen).toHaveLength(6);
    const plans = await Promise.all(seen.map(plan));
    for (const [i, p] of plans.slice(0, 3).entries()) {
      // A number in one repository goes straight to (account_id, pr_number, created_at).
      const index = i === 2 ? "reviews_account_pull" : "reviews_account_created";
      expect(p).toMatch(new RegExp(`SEARCH r(eviews)? USING INDEX ${index}`));
      expect(p).toMatch(/USING (COVERING )?INDEX repositories_account_repo/);
      expect(p).not.toMatch(/TEMP B-TREE/);
    }
    expect(plans[3]).toMatch(/SEARCH findings USING INDEX findings_account_status_created/);
    expect(plans[3]).not.toMatch(/TEMP B-TREE/);
    expect(plans[4]).toMatch(/SEARCH review_repos USING INDEX review_repos_account/);
    expect(plans[5]).toMatch(/SEARCH graph_repos USING INDEX graph_repos_account_repo/);
    for (const p of plans) expect(p).not.toMatch(/\bSCAN\b/);
  });

  it("a finding's issue is claimed and read by its unique index, a review's by (account_id, review_id)", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.findingIssues.ofReview("r");
    await d.findingIssues.of("f");
    await d.findingIssues.record("f", new Date(), { number: 1, url: "https://x/1" });
    await d.findingIssues.release("f", new Date());
    const [review, ...byFinding] = await Promise.all(seen.map(plan));
    expect(review).toMatch(/SEARCH finding_issues USING INDEX finding_issues_account_review/);
    for (const p of byFinding) {
      expect(p).toMatch(/SEARCH finding_issues USING (COVERING )?INDEX finding_issues_finding/);
    }
    for (const p of [review, ...byFinding]) expect(p).not.toMatch(/\bSCAN\b/);
    const cascade = await plan({
      sql: "SELECT id FROM finding_issues WHERE finding_id = ?",
      params: ["f"],
    });
    expect(cascade).toMatch(/SEARCH finding_issues USING (COVERING )?INDEX finding_issues_finding/);
  });

  it("a review's findings are found by review_id, for the delete's cascade", async () => {
    const p = await plan({ sql: "SELECT id FROM findings WHERE review_id = ?", params: ["r"] });
    expect(p).toMatch(/SEARCH findings USING (COVERING )?INDEX findings_review/);
  });
});

/** The plans of every statement a request to the app runs. */
async function plansOf(path: string, init: CallInit): Promise<string[]> {
  const seen: Captured[] = [];
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), { ...env, DB: recording(seen) }, ctx);
  await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return Promise.all(seen.map(async (q) => `${await plan(q)}\n  for ${q.sql}`));
}

// Audit C1: a cap is checked by reading the account's counter rows, not by
// counting its reviews, findings or calls, which grow with use.
const COUNTED = /\b(findings_account\w*|reviews_account_created|gateway_calls_account_created)\b/;

describe("checking a cap", () => {
  it("an upload with findings counts none of the account's records", async () => {
    await resetDb();
    const web = await signIn(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: true },
    });
    const { auth } = await signInCli(1, "octo");
    const plans = await plansOf("/api/reviews", {
      method: "POST",
      auth,
      json: {
        runId: "run",
        repoHash: "e".repeat(64),
        source: "local",
        findings: { critical: 0, warning: 1, suggestion: 0 },
        findingList: [
          {
            fingerprint: "fp-1",
            reviewer: "security",
            severity: "warning",
            file: "src/a.ts",
            title: "t",
            body: "b",
          },
        ],
      },
    });
    for (const p of plans) {
      expect(p).not.toMatch(COUNTED);
      // json_each is the upload's own findings; a subquery, its one count.
      expect(p).not.toMatch(/\bSCAN (?!json_each|\(subquery-\d+\))/);
    }
    expect(plans.join("\n")).toMatch(/insert into "usage_counters"/);
  });

  it("a gateway call counts none of the account's calls", async () => {
    await resetDb();
    const { auth } = await signIn(1, "octo");
    await call("/api/keys/openrouter", { method: "PUT", auth, json: { key: "sk-or-0123456789" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const plans = await plansOf("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth,
      json: { model: "m", messages: [] },
    });
    for (const p of plans) {
      expect(p).not.toMatch(COUNTED);
      expect(p).not.toMatch(/\bSCAN\b/);
    }
    expect(plans.join("\n")).toMatch(/insert into "usage_counters"/);
    vi.restoreAllMocks();
  });
});

describe("the weekly report", () => {
  it("reads closed pull requests through the (account_id, closed_at) index", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.closedPulls.mergedBetween(new Date(0), new Date(), 5);
    await d.closedPulls.mergeTimes(new Date(0), new Date(), 10);
    expect(seen).toHaveLength(3);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(/SEARCH closed_pulls USING INDEX closed_pulls_account_closed/);
      expect(p, q.sql).not.toMatch(/SCAN closed_pulls/);
    }
  });
});

describe("the review flow", () => {
  it("reads flows, merges and reviews through an index, never a whole table", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    for (const repos of [null, ["r1", "r2"]]) {
      await d.pullFlows.flowsSince(new Date(0), repos, 10);
      await d.pullFlows.mergedSince(new Date(0), repos, 10);
      await d.pullFlows.waiting(repos, 5);
      await d.pullFlows.reviewersSince(new Date(0), repos, 20);
    }
    await d.pullPaths.headOf("r1", 7);
    await d.pullPaths.reviewersIn(new Date(0), "r1", ["src", "src/db"], 200);
    expect(seen).toHaveLength(10);
    for (const q of seen) {
      const p = await plan(q);
      // By the account's index, or by the enrolled repositories asked for.
      expect(p, q.sql).toMatch(
        /SEARCH \w+ USING (COVERING )?INDEX (pull_flows_account_seen|closed_pulls_account_closed|pull_reviews_account_submitted|pull_flows_pull|closed_pulls_pull|pull_reviews_review|pull_paths_prefix|sqlite_autoindex_review_repos_1)/,
      );
      expect(p, q.sql).not.toMatch(
        /SCAN (pull_flows|closed_pulls|pull_reviews|pull_paths|review_repos)/,
      );
    }
  });
});

describe("what ocra changed", () => {
  it("reads reviews, findings, issues and pull requests through an index, never a whole table", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    const ids = ["https://github.com/octo/api", "https://github.com/octo/web"];
    await d.impact.reposSince(new Date(0), 10);
    for (const identities of [null, ids]) {
      await d.impact.reviewsSince(new Date(0), identities, 10);
      await d.impact.findingsSince(new Date(0), identities, 10);
    }
    await d.impact.firstReviews([{ repo: ids[0] ?? "", number: 7 }]);
    for (const repos of [null, ["r1", "r2"]]) {
      await d.impact.openedSince(new Date(0), repos, 10);
      await d.impact.mergedSince(new Date(0), repos, 10);
    }
    expect(seen).toHaveLength(12);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH \w+ USING (COVERING )?INDEX (reviews_account_created|reviews_account_pull|findings_review|finding_issues_account_review|pull_flows_account_seen|closed_pulls_account_closed|pull_flows_pull)/,
      );
      expect(p, q.sql).not.toMatch(
        /SCAN (reviews|findings|finding_issues|pull_flows|closed_pulls)\b/,
      );
    }
  });
});

describe("review threads", () => {
  it("finds a thread by its key and the inbox's waiting replies through an index", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.reviewThreads.reply({ reviewRepoId: "r1", threadKey: "1", byId: "7", at: new Date() });
    await d.reviewThreads.waiting({ kind: "github", host: "github.com" }, "42", [
      { repo: "octo/api", number: 5 },
    ]);
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH (review_threads|th) USING (COVERING )?INDEX (review_threads_thread|review_threads_pull)/,
      );
      expect(p, q.sql).not.toMatch(/SCAN (review_threads|th|review_repos|rr)\b/);
    }
  });
});

describe("@ocra commands", () => {
  it("lists a pull request's commands, ends its pause and fails the stuck ones through an index", async () => {
    const seen: Captured[] = [];
    const db = drizzle(recording(seen));
    const d = scoped(db, "acct");
    await d.commands.newest("r1", 7, 20);
    await d.commands.closed("r1", 7, new Date());
    const before = seen.length;
    await recoverJobs(db, new Date());
    const stuck = seen.slice(before).filter((q) => q.sql.startsWith('update "pull_commands"'));
    expect(stuck).toHaveLength(1);
    for (const q of [...seen.slice(0, 2), ...stuck]) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(/SEARCH (pull_commands|paused_pulls) USING (COVERING )?INDEX/);
      expect(p, q.sql).not.toMatch(/SCAN (pull_commands|paused_pulls)\b/);
    }
  });
});

describe("finding threads", () => {
  it("finds a thread by its key, its finding by the pull request's reviews, and a pull request's threads through an index", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    const on = { reviewRepoId: "r1", threadKey: "1" };
    const by = { id: "7", login: "rita" };
    await d.findingThreads.find(on);
    await d.findingThreads.setState({ ...on, state: "resolved", by, at: new Date() });
    await d.findingThreads.reply({
      ...on,
      by,
      at: new Date(),
      text: "why",
      redacted: false,
      truncated: false,
    });
    await d.findingThreads.ofPull("https://github.com/octo/api", 5);
    expect(seen).toHaveLength(4);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH finding_threads USING INDEX (finding_threads_thread|finding_threads_pull)/,
      );
      expect(p, q.sql).not.toMatch(/SCAN (finding_threads|findings|reviews)\b/);
    }
  });
});

describe("reviewer workload", () => {
  it("reads asks, reviews, open asks, authors and waits through an index, never a whole table", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    for (const repos of [null, ["r1", "r2"]]) {
      await d.reviewLoad.asksSince(new Date(0), repos, 10);
      await d.reviewLoad.reviewsSince(new Date(0), repos, 10);
      await d.reviewLoad.openAsks(repos, 10);
      await d.reviewLoad.authoredSince(new Date(0), repos, 10);
      await d.reviewLoad.waitsSince(new Date(0), repos, 10);
    }
    expect(seen).toHaveLength(10);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH (review_requests|pull_reviews|pull_flows) USING (COVERING )?INDEX (review_requests_account_requested|pull_reviews_account_submitted|pull_flows_account_seen)/,
      );
      expect(p, q.sql).not.toMatch(
        /SCAN (review_requests|pull_flows|pull_reviews|closed_pulls|review_repos)/,
      );
    }
  });
});

describe("review reminders", () => {
  it("reads the asks and the unreviewed pull requests through an index, never a whole table", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    const u = { platform: "github", host: "github.com", userId: "42" } as const;
    await d.reviewRequests.askedOf(u, new Date(0), new Date(), 25);
    await d.reviewRequests.unreviewedOf(u, new Date(0), new Date(), 25);
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH (review_requests|pull_flows) USING INDEX (review_requests_account_requested|pull_flows_account_seen)/,
      );
      expect(p, q.sql).not.toMatch(/SCAN (review_requests|pull_flows|closed_pulls|review_repos)/);
    }
  });
});

describe("pull requests at risk", () => {
  it("reads open pull requests and their waiting asks through an index, never a whole table", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.find("reviewTargets", {}, 101);
    await d.reviewTargets.openPulls(new Date(0), null, 2_000);
    await d.reviewTargets.openPulls(new Date(0), ["r1", "r2"], 2_000);
    await d.reviewTargets.waitingOn([{ reviewRepoId: "r1", number: 5 }]);
    expect(seen).toHaveLength(4);
    for (const q of seen) {
      const p = await plan(q);
      expect(p, q.sql).toMatch(
        /SEARCH (review_targets|pull_flows|review_requests) USING (COVERING )?INDEX (review_targets_account_scope|pull_flows_account_seen|pull_flows_pull|review_requests_pull_reviewer|review_requests_account_requested)/,
      );
      expect(p, q.sql).not.toMatch(
        /SCAN (review_targets|pull_flows|review_requests|closed_pulls|review_repos)/,
      );
    }
  });
});

describe("incoming deliveries", () => {
  it("finds the one due next through the retry index, never a whole table", async () => {
    const seen: Captured[] = [];
    await claimInboundRetry(drizzle(recording(seen)), new Date(), 60_000, ["11"]);
    expect(seen.length).toBeGreaterThan(0);
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(/SEARCH inbound_events USING INDEX inbound_events_retry/);
    expect(p).not.toMatch(/SCAN inbound_events/);
  });
  it("finds a stack merge by any layer through the repository's index", async () => {
    const seen: Captured[] = [];
    const key = { platform: "github" as const, host: "github.com", fullName: "octo/api" };
    await scoped(drizzle(recording(seen)), "acct").stackMerges.holding(key, 2);
    const p = await plan(seen[0] as Captured);
    expect(p).toMatch(/SEARCH stack_merges USING INDEX/);
    expect(p).not.toMatch(/SCAN stack_merges/);
  });
  it("finds the merge under way that holds a layer, gives a merge's layers up and removes them with it, each through an index", async () => {
    const seen: Captured[] = [];
    const merges = scoped(drizzle(recording(seen)), "acct").stackMerges;
    const key = { platform: "github" as const, host: "github.com", fullName: "octo/api" };
    await merges.heldBy(key, [2, 3]);
    await merges.cancel("m", new Date());
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) {
      const p = await plan(s);
      expect(p, s.sql).toMatch(
        /SEARCH (stack_merges|stack_merge_layers|t) USING (COVERING )?INDEX/,
      );
      expect(p, s.sql).not.toMatch(/SCAN stack_merge/);
    }
    const cascade = await plan({
      sql: "SELECT id FROM stack_merge_layers WHERE merge_id = ?",
      params: ["m"],
    });
    expect(cascade).toMatch(
      /SEARCH stack_merge_layers USING (COVERING )?INDEX stack_merge_layers_merge/,
    );
  });
});

describe("retention", () => {
  it("finds each table's old rows through an index, never reading the whole table (audit C3)", async () => {
    const seen: Captured[] = [];
    await enforceRetention(drizzle(recording(seen)), new Date());
    const plans = new Map<string, string>();
    for (const q of seen) {
      const table = q.sql.match(/^delete from "(\w+)"/)?.[1] ?? q.sql;
      plans.set(table, await plan(q));
    }
    expect([...plans.keys()].sort()).toEqual([
      "api_tokens",
      "audit_events",
      "automation_assignments",
      "automation_runs",
      "closed_pulls",
      "device_codes",
      "finding_threads",
      "gateway_calls",
      "generate_jobs",
      "inbound_events",
      "learn_jobs",
      "live_runs",
      "merge_check_runs",
      "merge_intents",
      "notify_channels",
      "notify_deliveries",
      "notify_held",
      "notify_sends",
      "pull_commands",
      "pull_file_views",
      "pull_flows",
      "pull_impacts",
      "pull_index",
      "pull_paths",
      "pull_reviews",
      "pull_seen",
      "rate_windows",
      "reply_jobs",
      "review_jobs",
      "review_requests",
      "review_teams",
      "review_threads",
      "reviews",
      "service_counters",
      "sessions",
      "stack_merges",
      "usage_counters",
    ]);
    for (const [table, p] of plans) {
      // DEVICE_DAILY_CODES a day at most.
      if (table === "device_codes") continue;
      expect(p, table).toMatch(new RegExp(`SEARCH ${table} USING (COVERING )?INDEX`));
      expect(p, table).not.toMatch(/\bSCAN\b/);
    }
  });
});

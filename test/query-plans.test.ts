import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
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
  graphRepos: "graph_repos",
  graphBuilds: "graph_builds",
  reviewRepos: "review_repos",
  reviewJobs: "review_jobs",
  notifyChannels: "notify_channels",
  closedPulls: "closed_pulls",
  pullFlows: "pull_flows",
  pullReviews: "pull_reviews",
  replyJobs: "reply_jobs",
  generateJobs: "generate_jobs",
  reviewWalkthroughs: "review_walkthroughs",
  automationRules: "automation_rules",
  automationRuns: "automation_runs",
  mergeChecks: "merge_checks",
  mergeCheckRuns: "merge_check_runs",
  reviewChatMessages: "review_chat_messages",
  liveRuns: "live_runs",
  liveEvents: "live_events",
  liveGrants: "live_grants",
  liveComments: "live_comments",
};

describe("query plans", () => {
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

  it("the daily digest reads reviews and findings through their account indexes", async () => {
    const seen: Captured[] = [];
    const d = scoped(drizzle(recording(seen)), "acct");
    await d.notify.digestOf(new Date(0), new Date(), true);
    await d.notify.digesting();
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
    for (const p of plans.slice(0, 3)) {
      expect(p).toMatch(/SEARCH r(eviews)? USING INDEX reviews_account_created/);
      expect(p).toMatch(/USING (COVERING )?INDEX repositories_account_repo/);
      expect(p).not.toMatch(/TEMP B-TREE/);
    }
    expect(plans[3]).toMatch(/SEARCH findings USING INDEX findings_account_status_created/);
    expect(plans[3]).not.toMatch(/TEMP B-TREE/);
    expect(plans[4]).toMatch(/SEARCH review_repos USING INDEX review_repos_account/);
    expect(plans[5]).toMatch(/SEARCH graph_repos USING INDEX graph_repos_account_repo/);
    for (const p of plans) expect(p).not.toMatch(/\bSCAN\b/);
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
    expect(seen).toHaveLength(8);
    for (const q of seen) {
      const p = await plan(q);
      // By the account's index, or by the enrolled repositories asked for.
      expect(p, q.sql).toMatch(
        /SEARCH \w+ USING (COVERING )?INDEX (pull_flows_account_seen|closed_pulls_account_closed|pull_reviews_account_submitted|pull_flows_pull|closed_pulls_pull|pull_reviews_review|sqlite_autoindex_review_repos_1)/,
      );
      expect(p, q.sql).not.toMatch(/SCAN (pull_flows|closed_pulls|pull_reviews|review_repos)/);
    }
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
      "audit_events",
      "automation_runs",
      "closed_pulls",
      "device_codes",
      "gateway_calls",
      "live_runs",
      "pull_flows",
      "pull_reviews",
      "rate_windows",
      "reviews",
      "service_counters",
      "sessions",
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

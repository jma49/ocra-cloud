import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { accountTables } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";

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

  it("a review's findings are found by review_id, for the delete's cascade", async () => {
    const p = await plan({ sql: "SELECT id FROM findings WHERE review_id = ?", params: ["r"] });
    expect(p).toMatch(/SEARCH findings USING (COVERING )?INDEX findings_review/);
  });
});

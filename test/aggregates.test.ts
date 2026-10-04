import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { call, resetDb, signIn } from "./helpers.js";

// Audit D5: usage, key use, review totals and the export are summed or
// paged in SQL, so they stay exact past the 10,000 rows a list used to stop at.

beforeEach(resetDb);

/** Inserts n rows in one statement, numbered 1..n as `i`. */
async function many(n: number, insert: string, ...binds: unknown[]) {
  await env.DB.prepare(
    `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${n}) ${insert}`,
  )
    .bind(...binds)
    .run();
}

const CALLS = 12_000;

async function seedCalls(accountId: string) {
  const now = Date.now();
  // Odd rows are openai m1, even rows anthropic m2; every third failed.
  await many(
    CALLS,
    `INSERT INTO gateway_calls (id, account_id, provider, path, model, status, tokens_in, tokens_out, ms, created_at)
     SELECT ?1 || '-' || i, ?1, CASE i % 2 WHEN 1 THEN 'openai' ELSE 'anthropic' END, '/v1/x',
       CASE i % 2 WHEN 1 THEN 'm1' ELSE 'm2' END, CASE i % 3 WHEN 0 THEN 500 ELSE 200 END,
       10, 1, 5, ?2 - i FROM seq`,
    accountId,
    now,
  );
}

describe("totals past 10,000 rows", () => {
  it("/api/usage counts every call", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await seedCalls(me.account.id);
    await seedCalls(other.account.id);
    const body = (await (await call("/api/usage?days=14", { headers: me.auth })).json()) as {
      today: number;
      series: {
        calls: number;
        errors: number;
        tokensIn: number;
        byModel: Record<string, unknown>;
      }[];
      models: { model: string; provider: string; calls: number; tokensIn: number }[];
      calls: unknown[];
    };
    const sum = (f: (d: (typeof body.series)[number]) => number) =>
      body.series.reduce((n, d) => n + f(d), 0);
    expect(sum((d) => d.calls)).toBe(CALLS);
    expect(sum((d) => d.errors)).toBe(CALLS / 3);
    expect(sum((d) => d.tokensIn)).toBe(CALLS * 10);
    expect([...body.models].sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      expect.objectContaining({ model: "m1", provider: "openai", calls: CALLS / 2 }),
      expect.objectContaining({ model: "m2", provider: "anthropic", calls: CALLS / 2 }),
    ]);
    expect(body.calls).toHaveLength(200);
  });

  it("GET /api/keys counts every call of the week", async () => {
    const me = await signIn(1, "octo");
    await env.DB.prepare(
      `INSERT INTO provider_keys (id, account_id, provider, wrapped_key, ciphertext, last4)
       VALUES ('k', ?1, 'openai', 'w', 'c', 'abcd')`,
    )
      .bind(me.account.id)
      .run();
    await seedCalls(me.account.id);
    const body = (await (await call("/api/keys", { headers: me.auth })).json()) as {
      keys: { provider: string; calls7d: number; lastUsedAt: string }[];
    };
    expect(body.keys).toEqual([
      expect.objectContaining({ provider: "openai", calls7d: CALLS / 2 }),
    ]);
    expect(new Date(body.keys[0]?.lastUsedAt ?? 0).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("the reviews summary counts every review, and days stop at 90", async () => {
    const me = await signIn(1, "octo");
    const n = 1_200;
    await many(
      n,
      `INSERT INTO reviews (id, account_id, run_id, repo_hash, source, verdict, findings, critical, by_reviewer, created_at)
       SELECT 'r' || i, ?1, 'run' || i, 'repo' || (i % 7), 'local',
         CASE i % 4 WHEN 0 THEN 'significant_concerns' ELSE 'approved' END, 3, 1,
         '{"security":{"tasks":2,"failedTasks":0,"findings":{"critical":1,"warning":0,"suggestion":0},"costUsd":0,"fixed":1,"dismissed":1}}',
         ?2 - i FROM seq`,
      me.account.id,
      Date.now(),
    );
    const body = (await (await call("/api/reviews?days=365", { headers: me.auth })).json()) as {
      days: number;
      summary: Record<string, number>;
      reviewers: Record<string, { tasks: number; findingsTotal: number; acceptanceRate: number }>;
      reviews: unknown[];
    };
    expect(body.days).toBe(90);
    expect(body.summary).toMatchObject({
      reviews: n,
      repositories: 7,
      findings: 3 * n,
      critical: n,
      blocking: n / 4,
      incomplete: 0,
    });
    expect(body.reviewers.security).toMatchObject({
      tasks: 2 * n,
      findingsTotal: n,
      acceptanceRate: 0.5,
    });
    expect(body.reviews).toHaveLength(500);
  });

  it("the export holds every row, a page at a time", async () => {
    const me = await signIn(1, "octo");
    const other = await signIn(2, "other");
    await seedCalls(me.account.id);
    await seedCalls(other.account.id);
    const res = await call("/api/export", { headers: me.auth });
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = (await res.json()) as { gatewayCalls: { id: string }[]; truncated?: unknown };
    expect(body.gatewayCalls).toHaveLength(CALLS);
    expect(new Set(body.gatewayCalls.map((c) => c.id)).size).toBe(CALLS);
    expect(body.truncated).toBeUndefined();
  });
});

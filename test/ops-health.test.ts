import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import sqliteJournal from "../migrations/meta/_journal.json" with { type: "json" };
import pgJournal from "../migrations-pg/meta/_journal.json" with { type: "json" };
import { appliedMigrations } from "../src/db/dialect.js";
import { COLLECTORS, OPS_METRICS, type Sample } from "../src/db/ops-metrics.js";
import * as schema from "../src/db/schema.js";
import { call, db } from "./helpers.js";
import { rows } from "./table-rows.js";

// What a self-hosting operator watches, on D1 and Postgres: the deep health
// check reads the migrations' ledger, the collectors count across accounts
// and label by queue, kind and state alone.

const A = "acct-a";
const B = "acct-b";
const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const deep = (address: string) =>
  call("/api/health?deep=1", { headers: { "cf-connecting-ip": address } });

describe("the deep health check", () => {
  it("leaves the plain check as it was", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers ok when every migration of this build is applied", async () => {
    const res = await deep("192.0.2.1");
    const body = (await res.json()) as { ok: boolean; migrations: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, reasons: [] });
    expect(body.migrations.missing).toEqual([]);
    expect(body.migrations.applied).toBe(body.migrations.expected);
  });

  it("limits deep checks per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await deep("192.0.2.2")).status);
    expect(statuses).toContain(429);
    expect((await deep("192.0.2.3")).status).toBe(200);
  });

  it("answers 503 naming the migration the database lacks", async () => {
    const ledger = await appliedMigrations(db);
    const journal = ledger?.dialect === "postgres" ? pgJournal : sqliteJournal;
    const last = journal.entries.at(-1);
    if (!ledger || !last) throw new Error("no ledger");
    await db.run(
      ledger.by === "tag"
        ? sql`DELETE FROM ${sql.raw(ledger.table)} WHERE name = ${`${last.tag}.sql`}`
        : sql`DELETE FROM ${sql.raw(ledger.table)} WHERE created_at = ${last.when}`,
    );
    const res = await deep("192.0.2.4");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      reasons: ["migrations_missing"],
      migrations: { missing: [last.tag], expected: journal.entries.length },
    });
  });
});

describe("the operations collectors", () => {
  beforeEach(async () => {
    await db.delete(schema.accounts);
    await db.insert(schema.accounts).values([
      { id: A, login: "secret-login-a" },
      { id: B, login: "secret-login-b" },
    ]);
    for (const accountId of [A, B]) {
      const repo = `review-repo-of-${accountId}`;
      await db.insert(schema.reviewRepos).values({ ...rows.reviewRepos(repo), accountId });
      await db.insert(schema.reviewJobs).values([
        { ...rows.reviewJobs(`q-${accountId}`), reviewRepoId: repo, accountId, createdAt: ago(30) },
        { ...rows.reviewJobs(`r-${accountId}`), reviewRepoId: repo, accountId, state: "running" },
        {
          ...rows.reviewJobs(`f-${accountId}`),
          reviewRepoId: repo,
          accountId,
          state: "failed",
          finishedAt: ago(10),
        },
        {
          ...rows.reviewJobs(`old-${accountId}`),
          reviewRepoId: repo,
          accountId,
          state: "failed",
          finishedAt: ago(90),
        },
      ]);
      await db.insert(schema.webhookDeliveries).values([
        {
          ...rows.webhookDeliveries(`p-${accountId}`),
          accountId,
          state: "pending",
          retryAt: ago(1),
        },
        {
          ...rows.webhookDeliveries(`w-${accountId}`),
          accountId,
          state: "pending",
          retryAt: ago(-5),
        },
        { ...rows.webhookDeliveries(`x-${accountId}`), accountId, state: "failed" },
      ]);
      await db
        .insert(schema.mergeIntents)
        .values({ ...rows.mergeIntents(`m-${accountId}`), accountId });
    }
  });

  const collect = async () => {
    const samples: Sample[] = [];
    for (const collector of Object.values(COLLECTORS)) samples.push(...(await collector(db, NOW)));
    return samples;
  };
  const value = (samples: Sample[], metric: string, labels: Record<string, string>) =>
    samples.find((s) => s.metric === metric && JSON.stringify(s.labels) === JSON.stringify(labels))
      ?.value;

  it("counts every account's jobs, deliveries and intents together", async () => {
    const samples = await collect();
    expect(value(samples, "ocra_jobs", { queue: "review", state: "queued" })).toBe(2);
    expect(value(samples, "ocra_jobs", { queue: "review", state: "running" })).toBe(2);
    expect(value(samples, "ocra_jobs_failed_last_hour", { queue: "review" })).toBe(2);
    expect(value(samples, "ocra_jobs_oldest_queued_seconds", { queue: "review" })).toBe(1800);
    expect(value(samples, "ocra_jobs", { queue: "graph", state: "queued" })).toBe(0);
    expect(value(samples, "ocra_jobs_oldest_queued_seconds", { queue: "reply" })).toBe(0);
    expect(value(samples, "ocra_deliveries", { kind: "webhook", state: "pending" })).toBe(4);
    expect(value(samples, "ocra_deliveries", { kind: "webhook", state: "failed" })).toBe(2);
    expect(value(samples, "ocra_delivery_retries_due", { kind: "webhook" })).toBe(2);
    expect(value(samples, "ocra_merge_intents", { state: "armed" })).toBe(2);
  });

  it("labels by queue, kind and state alone, never an account, repository or login", async () => {
    const samples = await collect();
    const text = JSON.stringify(samples);
    for (const leak of [A, B, "secret-login", "octo/", "review-repo-of"]) {
      expect(text).not.toContain(leak);
    }
    for (const { metric, labels } of samples) {
      expect(OPS_METRICS[metric].labels).toEqual(expect.arrayContaining(Object.keys(labels)));
    }
  });
});

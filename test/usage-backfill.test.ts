/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import migration from "../migrations/0014_usage_counters.sql?raw";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { DAY, utcDay } from "../src/time.js";
import { db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// Migration 0014 fills the new counters from the records already stored, so
// the caps hold on the day it is applied (audit C1).

beforeEach(resetDb);

const backfill = migration
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/^--.*$/gm, "").trim())
  .filter((s) => s.startsWith("INSERT"));

it("counts the stored findings by day, and today's uploads and gateway calls", async () => {
  const { account } = await signIn(1, "octo");
  const d = scoped(db, account.id);
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
  for (const [id, n] of [
    ["today", 0],
    ["earlier", 3],
  ] as const) {
    await d.insert("reviews", { ...rows.reviews(id), createdAt: daysAgo(n) });
    await d.insert("gatewayCalls", { ...rows.gatewayCalls(id), createdAt: daysAgo(n) });
  }
  await d.insert("gatewayCalls", rows.gatewayCalls("today-2"));
  for (const [id, review, n] of [
    ["f1", "today", 0],
    ["f2", "today", 0],
    ["f3", "earlier", 3],
  ] as const) {
    await d.insert("findings", { ...rows.findings(id), reviewId: review, createdAt: daysAgo(n) });
  }
  await db.delete(schema.usageCounters);

  expect(backfill).toHaveLength(3);
  for (const statement of backfill) await env.DB.prepare(statement).run();

  const counts = (await d.list("usageCounters")).map(({ kind, day, n }) => ({ kind, day, n }));
  expect(counts).toEqual(
    expect.arrayContaining([
      { kind: "findings", day: utcDay(daysAgo(0)), n: 2 },
      { kind: "findings", day: utcDay(daysAgo(3)), n: 1 },
      { kind: "uploads", day: utcDay(daysAgo(0)), n: 1 },
      { kind: "gateway_calls", day: utcDay(daysAgo(0)), n: 2 },
    ]),
  );
  expect(counts).toHaveLength(4);
});

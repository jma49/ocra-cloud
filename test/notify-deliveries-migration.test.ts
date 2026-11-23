/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import before from "../migrations/0065_webhook_deliveries.sql?raw";
import migration from "../migrations/0072_notify_deliveries.sql?raw";
import whens from "../migrations/0075_notify_delivery_whens.sql?raw";
import { scoped } from "../src/db/scoped.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// Migration 0072 renames webhook_deliveries to notify_deliveries in place:
// applied, as D1 applies it, in one transaction to the table as 0065 made it,
// it keeps every delivery and every row of the tables around it (0075,
// which adds a column the code reads, after it). A message
// still goes out when its delivery cannot be recorded.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const statementsOf = (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter((s) => s.length > 0);

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

it("keeps every delivery, channel and account, with the rows' values", async () => {
  const a = await signIn(1, "octo");
  const b = await signIn(2, "hubot");
  for (const who of [a, b]) {
    await scoped(db, who.account.id).insert("notifyChannels", rows.notifyChannels(who.account.id));
  }
  await env.DB.exec("DROP TABLE notify_deliveries");
  await env.DB.batch(statementsOf(before).map((s) => env.DB.prepare(s)));
  const insert = env.DB.prepare(
    "INSERT INTO webhook_deliveries (id, account_id, channel_id, event, state, attempts, status, payload, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch([
    insert.bind("d1", a.account.id, a.account.id, "ping", "pending", 1, 503, "{}", 1),
    insert.bind(
      "d2",
      a.account.id,
      a.account.id,
      "review_completed",
      "delivered",
      2,
      200,
      null,
      null,
    ),
    insert.bind("d3", b.account.id, b.account.id, "ping", "failed", 5, 404, null, null),
  ]);
  const accounts = await count("accounts");
  const channels = await count("notify_channels");

  await env.DB.batch(statementsOf(migration).map((s) => env.DB.prepare(s)));
  await env.DB.batch(statementsOf(whens).map((s) => env.DB.prepare(s)));

  expect(await count("notify_deliveries")).toBe(3);
  expect(await count("accounts")).toBe(accounts);
  expect(await count("notify_channels")).toBe(channels);
  expect(channels).toBe(2);
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%deliveries'",
  ).all<{ name: string }>();
  expect(tables.results.map((t) => t.name)).toEqual(["notify_deliveries"]);
  const pending = await scoped(db, a.account.id).get("notifyDeliveries", "d1");
  expect(pending).toMatchObject({
    state: "pending",
    attempts: 1,
    status: 503,
    payload: "{}",
    whens: null,
  });
  expect(await scoped(db, b.account.id).count("notifyDeliveries")).toBe(1);
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM notify_deliveries WHERE retry_at <= 5 ORDER BY retry_at",
  ).all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail).join(" ")).toContain("notify_deliveries_retry");
});

it("still sends a message when the delivery log cannot be written", async () => {
  const { auth } = await signIn(1, "octo");
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth,
    json: {
      kind: "slack",
      name: "team",
      when: "every",
      url: "https://hooks.slack.com/services/T000/B000/XXXXsecret",
    },
  });
  const { channel } = (await added.json()) as { channel: { id: string } };
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    posted.push(new Request(input).url);
    return new Response("ok");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.exec("ALTER TABLE notify_deliveries RENAME TO notify_deliveries_away");
  try {
    const res = await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth,
    });
    expect(await res.json()).toEqual({ delivered: true });
    expect(posted).toHaveLength(1);
  } finally {
    await env.DB.exec("ALTER TABLE notify_deliveries_away RENAME TO notify_deliveries");
  }
});

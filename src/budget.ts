import { type Context, Hono } from "hono";
import { z } from "zod";
import { auditRow } from "./audit.js";
import { config } from "./config.js";
import { jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { MAX_SPEND_LIMIT_USD } from "./shared/index.js";
import { spendOf } from "./spend.js";
import { utcDay } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's own limits: on the gateway's calls, under the service's
// daily cap, read in the statement that counts the call; and on what its
// reviews cost a day and a month (src/shared/spend.ts), read in the
// statement that claims a hosted job.

export const budget = new Hono<AppEnv>();

const budgetSchema = z.object({ dailyCalls: z.number().int().min(1).nullable() });

const usd = z.number().min(0.01).max(MAX_SPEND_LIMIT_USD).nullable();
const spendSchema = z.object({ dailyUsd: usd, monthlyUsd: usd });

async function answer(c: Context<AppEnv>) {
  const [row, today, spend] = await Promise.all([
    c.var.data.findOne("budgets", {}),
    c.var.data.findOne("usageCounters", { kind: "gateway_calls", day: utcDay(new Date()) }),
    spendOf(c.var.data),
  ]);
  return c.json({
    serviceDailyCalls: config(c.env).gatewayDailyCalls,
    dailyCalls: row?.dailyCalls ?? null,
    callsToday: today?.n ?? 0,
    spend,
  });
}

budget.get("/", requireSession(), (c) => answer(c));

budget.put("/", requireSession(), perMinute("settings"), jsonBody(budgetSchema), async (c) => {
  const { dailyCalls } = c.req.valid("json");
  await c.var.data.batch((w) => [
    w.upsert("budgets", { dailyCalls }, ["accountId"]),
    w.insert("auditEvents", auditRow("budget.changed", { dailyCalls })),
  ]);
  return answer(c);
});

budget.put("/spend", requireSession(), perMinute("settings"), jsonBody(spendSchema), async (c) => {
  const limits = c.req.valid("json");
  await c.var.data.batch((w) => [
    w.upsert("budgets", limits, ["accountId"]),
    w.insert("auditEvents", auditRow("budget.spend_changed", limits)),
  ]);
  // Work the old limit held back may start under the new one.
  c.var.autoReview?.kick();
  return answer(c);
});

import { type Context, Hono } from "hono";
import { z } from "zod";
import { auditRow } from "./audit.js";
import { config } from "./config.js";
import { jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { dailyCallCeiling, LIMIT_OFF, MAX_SPEND_LIMIT_USD } from "./shared/index.js";
import { spendOf } from "./spend.js";
import { utcDay } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's own limits (src/shared/budget.ts), each null for the
// server's default or LIMIT_OFF for none: on the gateway's calls a day, up
// to the server's ceiling, read in the statement that counts the call; and
// on what its reviews cost a day and a month, read in the statement that
// claims a hosted job.

export const budget = new Hono<AppEnv>();

const usd = z
  .union([z.literal(LIMIT_OFF), z.number().min(0.01).max(MAX_SPEND_LIMIT_USD)])
  .nullable();
const spendSchema = z.object({ dailyUsd: usd, monthlyUsd: usd });

async function answer(c: Context<AppEnv>) {
  const [row, today, spend] = await Promise.all([
    c.var.data.findOne("budgets", {}),
    c.var.data.findOne("usageCounters", { kind: "gateway_calls", day: utcDay(new Date()) }),
    spendOf(c.var.data),
  ]);
  const serviceDailyCalls = config(c.env).gatewayDailyCalls;
  return c.json({
    serviceDailyCalls,
    maxDailyCalls: dailyCallCeiling(serviceDailyCalls),
    dailyCalls: row?.dailyCalls ?? null,
    callsToday: today?.n ?? 0,
    spend,
  });
}

budget.get("/", requireSession(), (c) => answer(c));

const callsBody = jsonBody((c) =>
  z.object({
    dailyCalls: z
      .number()
      .int()
      .min(LIMIT_OFF)
      .max(dailyCallCeiling(config(c.env).gatewayDailyCalls))
      .nullable(),
  }),
);

budget.put("/", requireSession(), perMinute("settings"), callsBody, async (c) => {
  const { dailyCalls } = c.req.valid("json");
  await c.var.data.batch((w) => [
    w.upsert("budgets", { dailyCalls }, ["accountId"]),
    w.insert("auditEvents", auditRow("budget.changed", { dailyCalls })),
  ]);
  c.var.autoReview?.kick();
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

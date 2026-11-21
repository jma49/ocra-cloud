import { type Context, Hono } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { utcDay } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's own limit on the gateway, under the service's daily cap:
// a team that wants a review loop never to spend more than it planned sets
// it here. The gateway reads it in the statement that counts the call.

export const budget = new Hono<AppEnv>();

const budgetSchema = z.object({ dailyCalls: z.number().int().min(1).nullable() });

async function answer(c: Context<AppEnv>) {
  const [row, today] = await Promise.all([
    c.var.data.findOne("budgets", {}),
    c.var.data.findOne("usageCounters", { kind: "gateway_calls", day: utcDay(new Date()) }),
  ]);
  return c.json({
    serviceDailyCalls: config(c.env).gatewayDailyCalls,
    dailyCalls: row?.dailyCalls ?? null,
    callsToday: today?.n ?? 0,
  });
}

budget.get("/", requireSession(), (c) => answer(c));

budget.put("/", requireSession(), perMinute("settings"), jsonBody(budgetSchema), async (c) => {
  const { dailyCalls } = c.req.valid("json");
  await c.var.data.batch((w) => [w.upsert("budgets", { dailyCalls }, ["accountId"])]);
  return answer(c);
});

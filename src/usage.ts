import { Hono } from "hono";
import { config } from "./config.js";
import { queryDays } from "./http.js";
import { requireSession } from "./session.js";
import { DAY, utcDay, utcDayStart } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's gateway use: daily counts by model, and the latest calls.

export const usage = new Hono<AppEnv>().use(requireSession());

usage.get("/", async (c) => {
  const days = queryDays(c, 14);
  const todayStart = utcDayStart();
  const since = new Date(todayStart.getTime() - (days - 1) * DAY);
  // Summed in SQL (audit D5): exact however many calls there are.
  const [sums, latest, budget] = await Promise.all([
    c.var.data.usage(since),
    c.var.data.listSince("gatewayCalls", since, 200),
    c.var.data.findOne("budgets", {}),
  ]);
  const cap = config(c.env).gatewayDailyCalls;
  const own = budget?.dailyCalls;

  type Day = {
    day: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    errors: number;
    // A Map: a model name is the caller's string, and `__proto__` as a
    // plain object's key would replace its prototype, not add an entry
    // (audit C10). Object.fromEntries below makes it an own key.
    byModel: Map<string, { calls: number; tokens: number }>;
  };
  const series = new Map<string, Day>();
  for (let i = 0; i < days; i++) {
    const day = utcDay(new Date(since.getTime() + i * DAY));
    series.set(day, { day, calls: 0, tokensIn: 0, tokensOut: 0, errors: 0, byModel: new Map() });
  }
  for (const { day, ...totals } of sums.days) {
    const d = series.get(day);
    if (d) Object.assign(d, totals);
  }
  for (const { day, model, calls, tokens } of sums.dayModels) {
    const d = series.get(day);
    d?.byModel.set(model, { calls, tokens });
  }
  const today = series.get(utcDay(todayStart));
  return c.json({
    days,
    today: today?.calls ?? 0,
    // The account's own budget when it is the smaller (./budget.ts).
    dailyLimit: own != null && own < cap ? own : cap,
    series: [...series.values()].map((d) => ({ ...d, byModel: Object.fromEntries(d.byModel) })),
    models: sums.models,
    calls: latest.map((call) => ({
      id: call.id,
      provider: call.provider,
      path: call.path,
      model: call.model,
      status: call.status,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      ms: call.ms,
      createdAt: call.createdAt,
    })),
  });
});

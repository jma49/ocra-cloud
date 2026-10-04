import { Hono } from "hono";
import { clampDays } from "./db/retention.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// The account's gateway use: daily counts by model, and the latest calls.

export const usage = new Hono<AppEnv>().use(requireSession());

const DAY = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

usage.get("/", async (c) => {
  const days = clampDays(c.req.query("days"), 14);
  const todayStart = new Date(utcDay(new Date()));
  const since = new Date(todayStart.getTime() - (days - 1) * DAY);
  // Summed in SQL (audit D5): exact however many calls there are.
  const [sums, latest] = await Promise.all([
    c.var.data.usage(since),
    c.var.data.listSince("gatewayCalls", since, 200),
  ]);

  type Day = {
    day: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    errors: number;
    byModel: Record<string, { calls: number; tokens: number }>;
  };
  const series = new Map<string, Day>();
  for (let i = 0; i < days; i++) {
    const day = utcDay(new Date(since.getTime() + i * DAY));
    series.set(day, { day, calls: 0, tokensIn: 0, tokensOut: 0, errors: 0, byModel: {} });
  }
  for (const { day, ...totals } of sums.days) {
    const d = series.get(day);
    if (d) Object.assign(d, totals);
  }
  for (const { day, model, calls, tokens } of sums.dayModels) {
    const d = series.get(day);
    if (d) d.byModel[model] = { calls, tokens };
  }
  const today = series.get(utcDay(todayStart));
  return c.json({
    days,
    today: today?.calls ?? 0,
    dailyLimit: Number(c.env.GATEWAY_DAILY_CALLS),
    series: [...series.values()],
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

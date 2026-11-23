import type { Scoped } from "./db/scoped.js";
import { DEFAULT_SPEND_LIMITS, type SpendView } from "./shared/index.js";

/** The account's spend limits, its own or the defaults, and what its reviews cost so far. */
export async function spendOf(data: Scoped, now = new Date()): Promise<SpendView> {
  const [row, spent] = await Promise.all([data.findOne("budgets", {}), data.spent(now)]);
  return {
    dailyUsd: row?.dailyUsd ?? null,
    monthlyUsd: row?.monthlyUsd ?? null,
    spentTodayUsd: spent.todayUsd,
    spentMonthUsd: spent.monthUsd,
    defaults: { ...DEFAULT_SPEND_LIMITS },
  };
}

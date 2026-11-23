// The account's limit on what its reviews cost, in US dollars, per UTC day
// and per UTC calendar month: the cost each uploaded review reports, added
// up as it is stored. At a limit the server starts no hosted review, answer
// or generation until the window turns or the limit is raised.

/** What an account that set no limit of its own may spend. */
export const DEFAULT_SPEND_LIMITS = { dailyUsd: 10, monthlyUsd: 100 } as const;

/** The largest limit an account may set. */
export const MAX_SPEND_LIMIT_USD = 100_000;

/** The share of a limit past which the account is warned. */
const SPEND_WARN_AT = 0.8;

/** The least a hosted review is given to spend, so a claimed one can still say what it left. */
export const MIN_REVIEW_SPEND_USD = 0.01;

export type SpendWindow = "daily" | "monthly";

/** As /api/budget answers it; a limit of null is the default's. */
export type SpendView = {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  spentTodayUsd: number;
  spentMonthUsd: number;
  defaults: { dailyUsd: number; monthlyUsd: number };
};

type SpendLevel = "ok" | "warning" | "reached";

export type SpendWindowState = {
  window: SpendWindow;
  limitUsd: number;
  spentUsd: number;
  /** The share of the limit spent, at most 1. */
  used: number;
  level: SpendLevel;
};

const stateOf = (window: SpendWindow, limitUsd: number, spentUsd: number): SpendWindowState => {
  const used = limitUsd > 0 ? Math.min(spentUsd / limitUsd, 1) : 1;
  const level = spentUsd >= limitUsd ? "reached" : used >= SPEND_WARN_AT ? "warning" : "ok";
  return { window, limitUsd, spentUsd, used, level };
};

/** Each window's limit, spend and level, the day's first. */
export function spendStates(v: SpendView): [SpendWindowState, SpendWindowState] {
  return [
    stateOf("daily", v.dailyUsd ?? v.defaults.dailyUsd, v.spentTodayUsd),
    stateOf("monthly", v.monthlyUsd ?? v.defaults.monthlyUsd, v.spentMonthUsd),
  ];
}

/** The window whose limit holds hosted work back: the month's when both do, as it lasts longer. */
export function spendReached(v: SpendView): SpendWindowState | null {
  const [daily, monthly] = spendStates(v);
  return monthly.level === "reached" ? monthly : daily.level === "reached" ? daily : null;
}

/** What is left to spend before the nearer limit, never below zero. */
export function spendLeftUsd(v: SpendView): number {
  return Math.max(0, Math.min(...spendStates(v).map((s) => s.limitUsd - s.spentUsd)));
}

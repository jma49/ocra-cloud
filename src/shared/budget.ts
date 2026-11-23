// The account's limits, each with a default it may change or turn off:
// what its reviews cost in US dollars per UTC day and calendar month (the
// cost each uploaded review reports, added up as it is stored), and the
// model calls the gateway forwards for it per UTC day. At a limit the
// server starts no hosted review, answer or generation until the window
// turns or the limit is raised.

/** A stored limit of 0: the account turned that limit off. */
export const LIMIT_OFF = 0;

/** The most gateway calls an account may set a day, unless the server's default is higher. */
const MAX_DAILY_CALLS = 20_000;

/** The calls an account may make a day: its own number, the server's default, or with its limit off the ceiling. */
export function dailyCallLimit(own: number | null | undefined, serviceDefault: number): number {
  const ceiling = dailyCallCeiling(serviceDefault);
  if (own == null) return serviceDefault;
  return own === LIMIT_OFF ? ceiling : Math.min(own, ceiling);
}

/** The most calls a day any account may make on this server. */
export const dailyCallCeiling = (serviceDefault: number): number =>
  Math.max(MAX_DAILY_CALLS, serviceDefault);

/** What an account that set no limit of its own may spend. */
export const DEFAULT_SPEND_LIMITS = { dailyUsd: 10, monthlyUsd: 100 } as const;

/** The largest limit an account may set. */
export const MAX_SPEND_LIMIT_USD = 100_000;

/** The share of a limit past which the account is warned. */
const SPEND_WARN_AT = 0.8;

/** The least a hosted review is given to spend, so a claimed one can still say what it left. */
export const MIN_REVIEW_SPEND_USD = 0.01;

export type SpendWindow = "daily" | "monthly";

/** As /api/budget answers it; a limit of null is the default's, LIMIT_OFF none. */
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
  /** Null when the account turned this limit off. */
  limitUsd: number | null;
  spentUsd: number;
  /** The share of the limit spent, at most 1. */
  used: number;
  level: SpendLevel;
};

function stateOf(
  window: SpendWindow,
  own: number | null,
  fallback: number,
  spentUsd: number,
): SpendWindowState {
  if (own === LIMIT_OFF) return { window, limitUsd: null, spentUsd, used: 0, level: "ok" };
  const limitUsd = own ?? fallback;
  const used = Math.min(spentUsd / limitUsd, 1);
  const level = spentUsd >= limitUsd ? "reached" : used >= SPEND_WARN_AT ? "warning" : "ok";
  return { window, limitUsd, spentUsd, used, level };
}

/** Each window's limit, spend and level, the day's first. */
export function spendStates(v: SpendView): [SpendWindowState, SpendWindowState] {
  return [
    stateOf("daily", v.dailyUsd, v.defaults.dailyUsd, v.spentTodayUsd),
    stateOf("monthly", v.monthlyUsd, v.defaults.monthlyUsd, v.spentMonthUsd),
  ];
}

/** The window whose limit holds hosted work back: the month's when both do, as it lasts longer. */
export function spendReached(v: SpendView): (SpendWindowState & { limitUsd: number }) | null {
  const [daily, monthly] = spendStates(v);
  const held = [monthly, daily].find((s) => s.level === "reached");
  return held && held.limitUsd !== null ? { ...held, limitUsd: held.limitUsd } : null;
}

/** What is left to spend before the nearer limit, never below zero; Infinity with both off. */
export function spendLeftUsd(v: SpendView): number {
  const left = spendStates(v).map((s) =>
    s.limitUsd === null ? Infinity : s.limitUsd - s.spentUsd,
  );
  return Math.max(0, Math.min(...left));
}

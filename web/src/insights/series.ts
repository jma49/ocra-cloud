import type { Review, Reviews } from "../api.js";

// Daily series for the insights charts: findings by severity and review
// time from the listed reviews, spend from the account's spend per day.
// Pure, so the charts' numbers are tested without the chart library.

export type Point = { start: Date; end: Date; value: number };
export type Daily = {
  critical: Point[];
  warning: Point[];
  suggestion: Point[];
  spend: Point[];
  p50: Point[];
  p95: Point[];
};

/** Whether a series has nothing to draw: a flat line at zero says less than a sentence. */
export const flat = (points: Point[]) => points.every((p) => p.value === 0);

const DAY = 86_400_000;

/** The value at quantile q (0..1) of sorted numbers, nearest rank. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
}

/** One point per UTC day of the last `days` days, ending today; review time in seconds, only on days with reviews. */
export function daily(
  reviews: Review[],
  spend: Reviews["spend"],
  days: number,
  now = Date.now(),
): Daily {
  const spent = new Map(spend.map((s) => [s.day, s.usd]));
  const today = Math.floor(now / DAY) * DAY;
  const first = today - (days - 1) * DAY;
  const buckets = Array.from({ length: days }, () => [] as Review[]);
  for (const r of reviews) {
    const i = Math.floor((Date.parse(r.createdAt) - first) / DAY);
    if (i >= 0 && i < days) buckets[i]?.push(r);
  }
  const out: Daily = { critical: [], warning: [], suggestion: [], spend: [], p50: [], p95: [] };
  buckets.forEach((day, i) => {
    const start = new Date(first + i * DAY);
    const end = new Date(first + (i + 1) * DAY);
    const sum = (f: (r: Review) => number) => day.reduce((n, r) => n + f(r), 0);
    out.critical.push({ start, end, value: sum((r) => r.critical) });
    out.warning.push({ start, end, value: sum((r) => r.warning) });
    out.suggestion.push({ start, end, value: sum((r) => r.suggestion) });
    const usd = spent.get(start.toISOString().slice(0, 10)) ?? 0;
    out.spend.push({ start, end, value: Math.round(usd * 100) / 100 });
    const times = day.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
    const p50 = quantile(times, 0.5);
    const p95 = quantile(times, 0.95);
    if (p50 !== null) out.p50.push({ start, end, value: Math.round(p50) });
    if (p95 !== null) out.p95.push({ start, end, value: Math.round(p95) });
  });
  return out;
}

/** Below this many decided findings, a rate per reviewer is noise: say so instead of drawing it. */
const FEW_DECIDED = 5;

export type Acceptance = { reviewer: string; rate: number; decided: number };

/** The reviewers' rates worth a chart, or how many findings were decided when too few were. */
export function acceptanceChart(rows: Acceptance[]): { bars: Acceptance[] } | { decided: number } {
  const decided = rows.reduce((n, r) => n + r.decided, 0);
  return decided < FEW_DECIDED ? { decided } : { bars: rows.filter((r) => r.decided > 0) };
}

/**
 * Each reason named with its share and count: the legend says what a slice
 * label would, which a narrow card cuts short.
 */
export const shares = (reasons: { reason: string; n: number }[]) => {
  const all = reasons.reduce((sum, r) => sum + r.n, 0);
  return reasons.map((r) => ({
    category: `${r.reason} · ${Math.round((r.n / all) * 100)}% (${r.n})`,
    value: r.n,
  }));
};

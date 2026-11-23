// Pure helpers the charts share, so their numbers are tested without a DOM.

/** The smallest round number at or above `n` (1, 2, 2.5 or 5 times a power of ten), so the top gridline reads well. */
export function niceMax(n: number): number {
  if (!(n > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

/** "Nov 23" for a UTC day ("2026-11-23"), whatever the reader's time zone. */
export const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Which of `n` slots a pointer at `x` of `width` is over. */
export const slotAt = (x: number, width: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor((x / Math.max(1, width)) * n)));

/** Which side of the day at `pct` of the plot's width its tooltip opens on, so it stays in the plot. */
export const tipSide = (pct: number): "before" | "after" => (pct > 55 ? "before" : "after");

/** The step an arrow key moves the highlighted slot to, or null for any other key. */
export function stepKey(key: string, at: number | null, n: number): number | null {
  const from = at ?? n - 1;
  if (key === "ArrowLeft") return Math.max(0, at === null ? from : from - 1);
  if (key === "ArrowRight") return Math.min(n - 1, at === null ? from : from + 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

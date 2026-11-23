import type { SpendView } from "../../../src/shared/index.js";

// The account's gateway calls for the UTC day and what its reviews cost, as /api/budget answers.

export type Budget = {
  serviceDailyCalls: number;
  dailyCalls: number | null;
  callsToday: number;
  spend: SpendView;
};

/** The calls the account may make a day: its own limit while under the service's. */
export const dailyLimit = (b: Budget): number =>
  Math.min(b.dailyCalls ?? b.serviceDailyCalls, b.serviceDailyCalls);

const DAY_MS = 86_400_000;

/** The next midnight UTC, where the day's count starts again. */
export const resetsAt = (now = Date.now()): Date =>
  new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS);

/** The first midnight UTC of the next calendar month, where the month's spend starts again. */
function monthResetsAt(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** The reset as the viewer's clock shows it: the time for the day's, the date for the month's. */
export const resetLabel = (window: "daily" | "monthly", now = Date.now()): string =>
  window === "daily"
    ? resetsAt(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : monthResetsAt(now).toLocaleDateString(undefined, { month: "short", day: "numeric" });

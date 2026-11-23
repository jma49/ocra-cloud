// The account's gateway calls for the UTC day, as /api/budget answers.

export type Budget = { serviceDailyCalls: number; dailyCalls: number | null; callsToday: number };

/** The calls the account may make a day: its own limit while under the service's. */
export const dailyLimit = (b: Budget): number =>
  Math.min(b.dailyCalls ?? b.serviceDailyCalls, b.serviceDailyCalls);

const DAY_MS = 86_400_000;

/** The next midnight UTC, where the day's count starts again. */
export const resetsAt = (now = Date.now()): Date =>
  new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS);

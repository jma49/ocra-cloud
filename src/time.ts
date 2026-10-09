// Durations in milliseconds, and the UTC day the daily limits count in.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The UTC date of `d`, as `YYYY-MM-DD`. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Midnight UTC at the start of `now`'s day: where the daily limits reset. */
export const utcDayStart = (now = new Date()): Date => new Date(utcDay(now));

/** Whole seconds from `now` to the next midnight UTC, when a daily limit resets. */
export const secondsToNextUtcDay = (now = new Date()): number =>
  Math.max(1, Math.ceil((utcDayStart(now).getTime() + DAY - now.getTime()) / 1000));

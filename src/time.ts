// Durations in milliseconds, and the UTC day the daily limits count in.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The UTC date of `d`, as `YYYY-MM-DD`. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The first UTC date of `d`'s calendar month, as `YYYY-MM-01`. */
export const utcMonthStartDay = (d: Date): string => `${utcDay(d).slice(0, 7)}-01`;

/** Midnight UTC at the start of `now`'s day: where the daily limits reset. */
export const utcDayStart = (now = new Date()): Date => new Date(utcDay(now));

/** The next midnight UTC after `now`: when the daily limits reset. */
export const nextUtcDay = (now = new Date()): Date => new Date(utcDayStart(now).getTime() + DAY);

/** Whole seconds from `now` to the next midnight UTC, when a daily limit resets. */
export const secondsToNextUtcDay = (now = new Date()): number =>
  Math.max(1, Math.ceil((nextUtcDay(now).getTime() - now.getTime()) / 1000));

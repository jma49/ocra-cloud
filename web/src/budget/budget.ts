import { dailyCallLimit, type SpendView } from "../../../src/shared/index.js";
import { clock } from "../format.js";

// The account's gateway calls for the UTC day and what its reviews cost, as /api/budget answers.

export type Budget = {
  /** The server's default; an account may set its own number up to maxDailyCalls, or turn the limit off. */
  serviceDailyCalls: number;
  maxDailyCalls: number;
  /** Null for the default, LIMIT_OFF for none. */
  dailyCalls: number | null;
  callsToday: number;
  spend: SpendView;
};

/** The calls the account may make a day. */
export const dailyLimit = (b: Budget): number => dailyCallLimit(b.dailyCalls, b.serviceDailyCalls);

const DAY_MS = 86_400_000;

/** The next midnight UTC, where the day's count starts again. */
const resetsAt = (now = Date.now()): Date => new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS);

/** The first midnight UTC of the next calendar month, where the month's spend starts again. */
function monthResetsAt(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/**
 * The reset as the viewer sees it: the day's at their clock's time, the
 * month's as its UTC date, since in a zone west of UTC that midnight falls
 * on the month's last day.
 */
export const resetLabel = (window: "daily" | "monthly", now = Date.now()): string =>
  window === "daily"
    ? clock(resetsAt(now))
    : monthResetsAt(now).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });

import type { ScheduledReportTiming } from "../shared/index.js";
import { DAY, HOUR, MINUTE } from "../time.js";
import { timeZoneOf } from "./reminders.js";

// When a scheduled report goes: at its hour, in the account's time zone, on
// each day, on its weekday or on its day of the month. A period runs from
// one slot to the next, so a daylight saving change makes a day of 23 or 25
// hours, and a month is a calendar month. A period is named by the cadence
// and the local day, week or month it ends in, so moving a report's hour,
// weekday or day within one sends it once.

/** Local days looked back or forward for a slot: a monthly one is at most 31 days away. */
const SEARCH_DAYS = 62;

/** A local calendar day, as the UTC midnight of the same date. */
type Day = number;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, f);
  }
  return f;
}

/** The wall clock at t in timeZone, read as if it were UTC. */
function wallClock(t: number, timeZone: string): number {
  const p = Object.fromEntries(
    formatIn(timeZone)
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    (p.hour ?? 0) % 24,
    p.minute,
    p.second,
  );
}

const offsetAt = (t: number, timeZone: string) =>
  Math.round((wallClock(t, timeZone) - t) / MINUTE) * MINUTE;

/**
 * The first instant the wall clock in timeZone reads day at hour; in a
 * clock change's gap, the hour after it. The offsets half a day either side
 * are the two any change that day moves between.
 */
function instantOf(day: Day, hour: number, timeZone: string): number {
  const wall = day + hour * HOUR;
  const before = wall - offsetAt(wall - DAY / 2, timeZone);
  const after = wall - offsetAt(wall + DAY / 2, timeZone);
  const valid = [before, after].filter((t) => wallClock(t, timeZone) === wall);
  return valid.length > 0 ? Math.min(...valid) : before;
}

const localDay = (t: number, timeZone: string): Day => {
  const w = wallClock(t, timeZone);
  return w - (w % DAY);
};

function takes(day: Day, s: ScheduledReportTiming): boolean {
  const d = new Date(day);
  if (s.cadence === "weekly") return d.getUTCDay() === s.weekday;
  if (s.cadence === "monthly") return d.getUTCDate() === s.monthDay;
  return true;
}

const zone = (timeZone: string) => timeZoneOf(timeZone) ?? "UTC";

/** The latest slot at or before now. */
export function lastSlotIn(now: Date, s: ScheduledReportTiming, timeZone: string): Date {
  const tz = zone(timeZone);
  const today = localDay(now.getTime(), tz);
  for (let back = 0; back <= SEARCH_DAYS; back++) {
    const day = today - back * DAY;
    if (!takes(day, s)) continue;
    const at = instantOf(day, s.hour, tz);
    if (at <= now.getTime()) return new Date(at);
  }
  throw new Error("no slot");
}

/** The slot before slot. */
export function previousSlot(slot: Date, s: ScheduledReportTiming, timeZone: string): Date {
  return lastSlotIn(new Date(slot.getTime() - 1), s, timeZone);
}

/** The first slot after now. */
export function nextSlotIn(now: Date, s: ScheduledReportTiming, timeZone: string): Date {
  const tz = zone(timeZone);
  const today = localDay(now.getTime(), tz);
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead++) {
    const day = today + ahead * DAY;
    if (!takes(day, s)) continue;
    const at = instantOf(day, s.hour, tz);
    if (at > now.getTime()) return new Date(at);
  }
  throw new Error("no slot");
}

/** The local date of t, `YYYY-MM-DD`. */
export const localDate = (t: Date, timeZone: string): string =>
  new Date(localDay(t.getTime(), zone(timeZone))).toISOString().slice(0, 10);

/**
 * The period a slot ends: `daily:<date>`, `weekly:<the Monday of its week>`
 * or `monthly:<YYYY-MM>`, in the local calendar.
 */
export function periodKey(slot: Date, s: ScheduledReportTiming, timeZone: string): string {
  const day = localDay(slot.getTime(), zone(timeZone));
  if (s.cadence === "monthly") return `monthly:${new Date(day).toISOString().slice(0, 7)}`;
  if (s.cadence === "daily") return `daily:${new Date(day).toISOString().slice(0, 10)}`;
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  return `weekly:${new Date(monday).toISOString().slice(0, 10)}`;
}

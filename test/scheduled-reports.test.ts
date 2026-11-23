import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hourIn } from "../src/notify/reminders.js";
import { runReports } from "../src/notify/report.js";
import { lastSlotIn, nextSlotIn, periodKey } from "../src/notify/report-slots.js";
import { runScheduledReports } from "../src/notify/scheduled-reports.js";
import type { ScheduledReportsView, ScheduledReportView } from "../src/shared/index.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb } from "./helpers.js";
import {
  account,
  merged,
  nextHourInTokyo,
  out,
  review,
  SLACK,
  slack,
} from "./scheduled-report-fixtures.js";

// When scheduled reports go, in the account's time zone, and what a slot
// sends: each period once, counting only the report's repositories and
// holding only its sections; and the weekly report still going as before.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("a report's slots", () => {
  const tz = "Europe/Berlin";

  it("fall at the hour in the account's time zone, daily, weekly and monthly", () => {
    const now = new Date("2026-11-25T08:30:00Z"); // Wednesday, 09:30 in Berlin
    const daily = { cadence: "daily" as const, hour: 9, weekday: null, monthDay: null };
    expect(lastSlotIn(now, daily, tz).toISOString()).toBe("2026-11-25T08:00:00.000Z");
    expect(nextSlotIn(now, daily, tz).toISOString()).toBe("2026-11-26T08:00:00.000Z");
    const weekly = { cadence: "weekly" as const, hour: 9, weekday: 1, monthDay: null };
    expect(lastSlotIn(now, weekly, tz).toISOString()).toBe("2026-11-23T08:00:00.000Z");
    expect(periodKey(lastSlotIn(now, weekly, tz), weekly, tz)).toBe("weekly:2026-11-23");
    const monthly = { cadence: "monthly" as const, hour: 0, weekday: null, monthDay: 1 };
    expect(lastSlotIn(now, monthly, tz).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(nextSlotIn(now, monthly, tz).toISOString()).toBe("2026-11-30T23:00:00.000Z");
    expect(periodKey(lastSlotIn(now, monthly, tz), monthly, tz)).toBe("monthly:2026-11");
  });

  it("follow the clock across a daylight saving change", () => {
    const daily = { cadence: "daily" as const, hour: 9, weekday: null, monthDay: null };
    // Berlin leaves summer time on 2026-10-25.
    expect(lastSlotIn(new Date("2026-10-24T12:00:00Z"), daily, tz).toISOString()).toBe(
      "2026-10-24T07:00:00.000Z",
    );
    expect(lastSlotIn(new Date("2026-10-25T12:00:00Z"), daily, tz).toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );
    // 02:30 does not exist on 2026-03-29: the hour after the gap.
    const gap = { cadence: "daily" as const, hour: 2, weekday: null, monthDay: null };
    expect(lastSlotIn(new Date("2026-03-29T12:00:00Z"), gap, tz).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });
});

describe("a scheduled report's slot", () => {
  it("send each period once, counting only their repositories and holding only their sections", async () => {
    const posted = slack();
    const { web, cli, channel, data, api, site } = await account();
    await review(cli, "run-api", "octo/api", true);
    await review(cli, "run-site", "octo/site", true);
    await merged(data, api, 1);
    await merged(data, site, 2);
    await merged(data, site, 3);
    const res = await call("/api/scheduled-reports", {
      method: "POST",
      auth: web.auth,
      json: {
        name: "API <@here> daily",
        cadence: "daily",
        hour: nextHourInTokyo(),
        repoIds: [api],
        sections: ["reviews", "open_findings", "merged", "time_to_merge"],
        channelIds: [channel],
      },
    });
    const { report } = (await res.json()) as { report: ScheduledReportView };
    const at = new Date(new Date(report.next).getTime() + 10 * 60_000);
    posted.length = 0;

    // Not before its slot; then once however many runs race for it.
    await runScheduledReports(db, out, [], new Date(at.getTime() - HOUR));
    expect(posted).toEqual([]);
    await Promise.all([runScheduledReports(db, out, [], at), runScheduledReports(db, out, [], at)]);
    await runScheduledReports(db, out, [], new Date(at.getTime() + HOUR));
    expect(posted).toHaveLength(1);
    const text = posted[0] ?? "";
    expect(text).toContain("ocra's report API here daily");
    expect(text).toContain("(Asia/Tokyo)");
    expect(text).toContain("Reviews: 1 review of 1 pull request");
    expect(text).toContain("critical: Unchecked input in octo/api");
    expect(text).not.toContain("octo/site");
    expect(text).toContain("Merged: 1 pull request\n• octo/api#1 Pull 1");
    expect(text).toContain("Median time to merge: 2h 0m");
    expect(text).not.toContain("fixed");
    expect(text).not.toContain("Most reviewed");

    const listed = (await (
      await call("/api/scheduled-reports", { auth: web.auth })
    ).json()) as ScheduledReportsView;
    expect(listed.reports[0]?.lastSent).toMatchObject({ channels: 1 });
    expect(listed.reports[0]?.lastSent?.period).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);
  });

  it("send nothing for an empty period, nor for a slot before they were saved", async () => {
    const posted = slack();
    const { web, cli, channel, site } = await account();
    await review(cli, "run-1", "octo/api", false);
    const add = async (hour: number, repoIds: string[] | null) => {
      const res = await call("/api/scheduled-reports", {
        method: "POST",
        auth: web.auth,
        json: {
          name: "r",
          cadence: "daily",
          hour,
          repoIds,
          sections: ["reviews"],
          channelIds: [channel],
        },
      });
      return ((await res.json()) as { report: ScheduledReportView }).report;
    };
    // Its slot began this hour, before it was saved: it waits for tomorrow's.
    await add(hourIn(new Date(), "Asia/Tokyo"), null);
    await runScheduledReports(db, out, [], new Date());
    expect(posted).toEqual([]);
    // octo/site had no reviews or merges: the period is taken and nothing is sent.
    const quiet = await add(nextHourInTokyo(), [site]);
    await runScheduledReports(db, out, [], new Date(new Date(quiet.next).getTime() + 60_000));
    expect(posted).toEqual([]);
    const listed = (await (
      await call("/api/scheduled-reports", { auth: web.auth })
    ).json()) as ScheduledReportsView;
    expect(listed.reports.map((r) => r.lastSent?.channels ?? null)).toEqual([null, 0]);
  });

  it("leave the weekly report going as before", async () => {
    const posted = slack("ocra's week");
    const { web, cli } = await account();
    await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "slack", name: "weekly", when: "every", url: SLACK, weekly: true },
    });
    const slot = new Date(Math.ceil((Date.now() + 1) / HOUR) * HOUR);
    await call("/api/notifications/report", {
      method: "PUT",
      auth: web.auth,
      json: { weekday: slot.getUTCDay(), hour: slot.getUTCHours() },
    });
    await review(cli, "run-1", "octo/api", false);
    posted.length = 0;
    await runReports(db, out, new Date(slot.getTime() + 60_000));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("ocra's week from");
  });
});

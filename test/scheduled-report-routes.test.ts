import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ScheduledReportPreview,
  ScheduledReportsView,
  ScheduledReportView,
} from "../src/shared/index.js";
import { call, resetDb, signIn } from "./helpers.js";
import { account, review, slack } from "./scheduled-report-fixtures.js";

// The scheduled reports' routes: saved by the web session under a cap,
// checked against their cadence and the account's repositories and
// channels, previewed and sent now over their period so far.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("scheduled reports", () => {
  it("are added, listed, replaced and removed by the web session, under a cap", async () => {
    const { web, cli, channel, api } = await account();
    const body = {
      name: "API weekly",
      cadence: "weekly",
      weekday: 1,
      hour: 9,
      repoIds: [api, api],
      sections: ["merged", "reviews", "merged"],
      channelIds: [channel],
    };
    const res = await call("/api/scheduled-reports", {
      method: "POST",
      auth: web.auth,
      json: body,
    });
    expect(res.status).toBe(200);
    const { report } = (await res.json()) as { report: ScheduledReportView };
    expect(report).toMatchObject({
      name: "API weekly",
      enabled: true,
      cadence: "weekly",
      weekday: 1,
      monthDay: null,
      repoIds: [api],
      sections: ["reviews", "merged"],
      channelIds: [channel],
      timeZone: "Asia/Tokyo",
      lastSent: null,
    });
    // Monday 09:00 in Tokyo is 00:00 UTC.
    expect(new Date(report.next).getUTCDay()).toBe(1);
    expect(new Date(report.next).getUTCHours()).toBe(0);

    const put = await call(`/api/scheduled-reports/${report.id}`, {
      method: "PUT",
      auth: web.auth,
      json: { ...body, cadence: "monthly", weekday: null, monthDay: 15, enabled: false },
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { report: ScheduledReportView }).report).toMatchObject({
      cadence: "monthly",
      monthDay: 15,
      enabled: false,
    });
    const listed = (await (
      await call("/api/scheduled-reports", { auth: web.auth })
    ).json()) as ScheduledReportsView;
    expect(listed.reports.map((r) => r.id)).toEqual([report.id]);
    expect(listed.max).toBe(10);
    expect((await call("/api/scheduled-reports", { auth: cli.auth })).status).toBe(403);

    for (let i = 1; i < 10; i++) {
      const more = await call("/api/scheduled-reports", {
        method: "POST",
        auth: web.auth,
        json: { ...body, name: `r${i}` },
      });
      expect(more.status).toBe(200);
    }
    const over = await call("/api/scheduled-reports", {
      method: "POST",
      auth: web.auth,
      json: body,
    });
    expect(over.status).toBe(400);

    const removed = await call(`/api/scheduled-reports/${report.id}`, {
      method: "DELETE",
      auth: web.auth,
    });
    expect(await removed.json()).toEqual({ removed: true });
  });

  it("refuse a schedule that does not fit its cadence, and repositories or channels not the account's", async () => {
    const { web, channel, api } = await account();
    const other = await signIn(2, "hubot");
    const hook = await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "webhook", name: "hook", when: "every", url: "https://example.com/hook" },
    });
    const webhook = ((await hook.json()) as { channel: { id: string } }).channel.id;
    const ok = {
      name: "r",
      cadence: "daily",
      hour: 9,
      repoIds: null,
      sections: ["reviews"],
      channelIds: [channel],
    };
    for (const json of [
      { ...ok, cadence: "weekly" },
      { ...ok, weekday: 2 },
      { ...ok, cadence: "monthly", monthDay: 29 },
      { ...ok, hour: 24 },
      { ...ok, sections: [] },
      { ...ok, sections: ["summary"] },
      { ...ok, channelIds: [] },
      { ...ok, channelIds: [webhook] },
      { ...ok, repoIds: ["not-a-repo"] },
    ]) {
      const res = await call("/api/scheduled-reports", { method: "POST", auth: web.auth, json });
      expect(res.status, JSON.stringify(json)).toBe(400);
    }
    // Another account sees neither the report nor its repositories.
    const made = await call("/api/scheduled-reports", {
      method: "POST",
      auth: web.auth,
      json: { ...ok, repoIds: [api] },
    });
    const { report } = (await made.json()) as { report: ScheduledReportView };
    for (const path of [`/${report.id}/preview`, `/${report.id}/send`]) {
      const res = await call(`/api/scheduled-reports${path}`, { method: "POST", auth: other.auth });
      expect(res.status).toBe(404);
    }
    const theirs = await call("/api/scheduled-reports/preview", {
      method: "POST",
      auth: other.auth,
      json: { ...ok, repoIds: [api], channelIds: undefined },
    });
    expect(theirs.status).toBe(400);
  });

  it("are previewed, saved or not, and sent now to their channels, over the period so far", async () => {
    const posted = slack();
    const { web, cli, channel, api } = await account();
    const draft = {
      name: "draft",
      cadence: "weekly",
      weekday: 1,
      hour: 9,
      repoIds: [api],
      sections: ["reviews", "top_repos", "outcomes"],
    };
    const preview = async () => {
      const res = await call("/api/scheduled-reports/preview", {
        method: "POST",
        auth: web.auth,
        json: draft,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as ScheduledReportPreview;
    };
    const before = await preview();
    expect(before.period.key).toMatch(/^weekly:/);
    expect(before.empty).toBe(true);
    expect(before.lines).toContain("Reviews: 0 reviews");
    await review(cli, "run-1", "octo/api", true);
    const after = await preview();
    expect(after.empty).toBe(false);
    expect(after.lines).toContain("Reviews: 1 review of 1 pull request");
    expect(posted).toEqual([]);

    const made = await call("/api/scheduled-reports", {
      method: "POST",
      auth: web.auth,
      json: { ...draft, channelIds: [channel] },
    });
    const { report } = (await made.json()) as { report: ScheduledReportView };
    const sent = await call(`/api/scheduled-reports/${report.id}/send`, {
      method: "POST",
      auth: web.auth,
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ delivered: 1, channels: 1, empty: false });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Most reviewed: octo/api (1)");
    expect(posted[0]).toContain("1 fixed · 0 dismissed · 1 still open");
  });
});

import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { newId, type Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute, retryTomorrow } from "../rate.js";
import { requireSession } from "../session.js";
import {
  MAX_REPORT_CHANNELS,
  MAX_REPORT_REPOS,
  MAX_SCHEDULED_REPORTS,
  REPORT_CADENCES,
  REPORT_SECTIONS,
  type ScheduledReportPreview,
  type ScheduledReportSent,
  type ScheduledReportsView,
  type ScheduledReportView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { outboxOf } from "./notify.js";
import { nextSlotIn } from "./report-slots.js";
import {
  periodSoFar,
  previewOf,
  type ReportOf,
  reportMessage,
  sendToChannels,
  timingOf,
} from "./scheduled-reports.js";

// The account's scheduled reports: added, replaced and removed by the web
// session, previewed (saved or not) over their period so far, and sent
// now to their channels, a few times a day; a send now is not a slot's,
// which still goes.

export const scheduledReportsRoute = new Hono<AppEnv>().use(requireSession(["web"]));

/** Reports sent now an account may ask for a day: each posts to every channel of one. */
const DAILY_SENDS = 20;

const unique = <T>(list: T[]) => [...new Set(list)];
const id = z.string().min(1).max(64);

const base = {
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  cadence: z.enum(REPORT_CADENCES),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
  monthDay: z.number().int().min(1).max(28).nullable().default(null),
  repoIds: z.array(id).min(1).max(MAX_REPORT_REPOS).transform(unique).nullable().default(null),
  sections: z
    .array(z.enum(REPORT_SECTIONS))
    .min(1)
    .max(REPORT_SECTIONS.length * 2)
    .transform((list) => REPORT_SECTIONS.filter((s) => list.includes(s))),
};

type Timing = { cadence: string; weekday: number | null; monthDay: number | null };

/** weekly takes a weekday and monthly a day of the month, each nothing else. */
function timingIssue(b: Timing, ctx: z.RefinementCtx) {
  const want = { weekday: b.cadence === "weekly", monthDay: b.cadence === "monthly" };
  for (const key of ["weekday", "monthDay"] as const) {
    if (want[key] !== (b[key] !== null)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: want[key]
          ? `${b.cadence} needs ${key}`
          : `only for a ${key === "weekday" ? "weekly" : "monthly"} report`,
      });
    }
  }
}

const saveBody = z
  .object({ ...base, channelIds: z.array(id).min(1).max(MAX_REPORT_CHANNELS).transform(unique) })
  .superRefine(timingIssue);
const previewBody = z
  .object({ ...base, name: base.name.default("preview") })
  .superRefine(timingIssue);

type SaveBody = z.output<typeof saveBody>;

const issue = (path: (string | number)[], message: string) => ({ issues: [{ path, message }] });

/** Why the report cannot be saved or previewed, as invalid_body's issue; undefined when it can. */
async function refusal(
  data: AppEnv["Variables"]["data"],
  body: { repoIds: string[] | null; channelIds?: string[] },
) {
  if (body.repoIds) {
    const known = new Set((await data.scheduledReports.repos(body.repoIds)).map((r) => r.id));
    const i = body.repoIds.findIndex((r) => !known.has(r));
    if (i >= 0) return issue(["repoIds", i], "not a repository this account enrolled");
  }
  for (const [i, channelId] of (body.channelIds ?? []).entries()) {
    const channel = await data.get("notifyChannels", channelId);
    if (!channel) return issue(["channelIds", i], "not a channel of this account");
    if (channel.kind === "webhook") return issue(["channelIds", i], "a webhook takes no report");
  }
  return undefined;
}

const reportView = (
  r: Row<"scheduledReports">,
  timeZone: string,
  last: { period: string; at: Date; channels: number } | undefined,
  now: Date,
) =>
  ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    cadence: r.cadence,
    hour: r.hour,
    weekday: r.weekday,
    monthDay: r.monthDay,
    repoIds: r.repoIds,
    sections: r.sections,
    channelIds: r.channelIds,
    next: nextSlotIn(now, r, timeZone).toISOString(),
    timeZone,
    lastSent: last
      ? { period: last.period, at: last.at.toISOString(), channels: last.channels }
      : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }) satisfies ScheduledReportView;

async function viewOf(c: Context<AppEnv>, r: Row<"scheduledReports">) {
  const data = c.var.data;
  const [timeZone, last] = await Promise.all([
    data.notify.timeZone(),
    data.scheduledReports.lastSends([r.id]),
  ]);
  return reportView(r, timeZone, last.get(r.id), new Date());
}

/** The report's period so far, made as its slot will make it. */
async function made(c: Context<AppEnv>, report: ReportOf) {
  const data = c.var.data;
  const [timeZone, share] = await Promise.all([
    data.notify.timeZone(),
    data.scheduledReports.keepsFindings(),
  ]);
  const period = periodSoFar(new Date(), timingOf(report), timeZone);
  const out = outboxOf(c);
  const m = await reportMessage(data, report, period, {
    timeZone,
    share,
    platforms: platformsOf(c.env, c.req.url),
    origin: out.origin,
  });
  return { period, m, out };
}

scheduledReportsRoute.get("/", async (c) => {
  const data = c.var.data;
  const [rows, timeZone] = await Promise.all([
    data.find("scheduledReports", {}, MAX_SCHEDULED_REPORTS),
    data.notify.timeZone(),
  ]);
  const last = await data.scheduledReports.lastSends(rows.map((r) => r.id));
  const now = new Date();
  return c.json({
    reports: rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => reportView(r, timeZone, last.get(r.id), now)),
    max: MAX_SCHEDULED_REPORTS,
  } satisfies ScheduledReportsView);
});

scheduledReportsRoute.post("/", perMinute("settings"), jsonBody(saveBody), async (c) => {
  const body: SaveBody = c.req.valid("json");
  const refused = await refusal(c.var.data, body);
  if (refused) return apiError(c, "invalid_body", refused);
  const reportId = newId();
  if (!(await c.var.data.scheduledReports.add({ id: reportId, ...body }, MAX_SCHEDULED_REPORTS))) {
    return apiError(
      c,
      "invalid_body",
      issue(["name"], `the account has ${MAX_SCHEDULED_REPORTS} reports`),
    );
  }
  const stored = await c.var.data.get("scheduledReports", reportId);
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "report.added", { report: reportId, cadence: stored.cadence });
  return c.json({ report: await viewOf(c, stored) });
});

scheduledReportsRoute.put("/:id", perMinute("settings"), jsonBody(saveBody), async (c) => {
  const reportId = c.req.param("id");
  const body: SaveBody = c.req.valid("json");
  const refused = await refusal(c.var.data, body);
  if (refused) return apiError(c, "invalid_body", refused);
  const changed = await c.var.data.update("scheduledReports", reportId, {
    ...body,
    updatedAt: new Date(),
  });
  const stored = changed && (await c.var.data.get("scheduledReports", reportId));
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "report.changed", {
    report: reportId,
    cadence: stored.cadence,
    enabled: stored.enabled,
  });
  return c.json({ report: await viewOf(c, stored) });
});

scheduledReportsRoute.delete("/:id", async (c) => {
  const reportId = c.req.param("id");
  const removed = await c.var.data.remove("scheduledReports", reportId);
  if (removed) await audit(c.var.data, "report.removed", { report: reportId });
  return c.json({ removed });
});

/** A report not saved yet, over its period so far; nothing is sent. */
scheduledReportsRoute.post("/preview", perMinute("settings"), jsonBody(previewBody), async (c) => {
  const body = c.req.valid("json");
  const refused = await refusal(c.var.data, body);
  if (refused) return apiError(c, "invalid_body", refused);
  const { period, m } = await made(c, body);
  return c.json(previewOf(period, m) satisfies ScheduledReportPreview);
});

scheduledReportsRoute.post("/:id/preview", perMinute("settings"), async (c) => {
  const report = await c.var.data.get("scheduledReports", c.req.param("id"));
  if (!report) return apiError(c, "not_found");
  const { period, m } = await made(c, report);
  return c.json(previewOf(period, m) satisfies ScheduledReportPreview);
});

/** The report's period so far sent now to its confirmed channels, even when empty. */
scheduledReportsRoute.post("/:id/send", perMinute("settings"), async (c) => {
  const report = await c.var.data.get("scheduledReports", c.req.param("id"));
  if (!report) return apiError(c, "not_found");
  if (!(await c.var.data.take("report_sends", DAILY_SENDS))) {
    retryTomorrow(c);
    return apiError(c, "daily_limit", { limit: DAILY_SENDS });
  }
  const { period, m, out } = await made(c, report);
  const sent = await sendToChannels(c.var.data, out, report.channelIds, m.message);
  return c.json({ ...previewOf(period, m), ...sent } satisfies ScheduledReportSent);
});

import type { CallBudget } from "../calls.js";
import { quantile } from "../cycles.js";
import { keepsStored } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { enabledReports, type RepoScope } from "../db/scheduled-reports.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { repoIdentity } from "../platforms/platform.js";
import type {
  ReportSection,
  ScheduledReportPreview,
  ScheduledReportTiming,
} from "../shared/index.js";
import { DAY } from "../time.js";
import { type Message, plain } from "./channels.js";
import { forAccounts, mergedLines, plural } from "./digest.js";
import { type Outbox, send } from "./notify.js";
import { repoName, span } from "./report.js";
import { lastSlotIn, localDate, nextSlotIn, periodKey, previousSlot } from "./report-slots.js";

// The reports an account defines: at each slot (src/notify/report-slots.ts)
// the period since the slot before, counted over its repositories, with the
// sections it chose, sent to its channels. A period is claimed by its
// unique row before anything is read, so it is made once whichever process
// runs it; a slot is due for a day after it, and only one after the report
// was last saved, so a new or changed report waits for its next slot; a period without
// reviews or merges sends nothing. The hosted Worker runs them in the weekly
// report's share of the hourly run's calls.

const MERGED_TITLES = 5;
/** Merge times a median is taken over: the newest. */
const MAX_MERGE_TIMES = 1000;

export type ReportOf = Pick<
  Row<"scheduledReports">,
  "name" | "cadence" | "hour" | "weekday" | "monthDay" | "repoIds" | "sections"
>;

/** What names a platform's repositories as reviews do: its address by kind and host. */
export type PlatformAddress = { kind: string; host: string; url: string };

export type Period = { key: string; from: Date; to: Date };

export const timingOf = (r: ScheduledReportTiming): ScheduledReportTiming => ({
  cadence: r.cadence,
  hour: r.hour,
  weekday: r.weekday,
  monthDay: r.monthDay,
});

/** The period in progress: from the latest slot to now, named as its slot will name it. */
export function periodSoFar(now: Date, r: ScheduledReportTiming, timeZone: string): Period {
  const next = nextSlotIn(now, r, timeZone);
  return { key: periodKey(next, r, timeZone), from: lastSlotIn(now, r, timeZone), to: now };
}

/** The period the latest slot at or before now ends. */
function lastPeriod(now: Date, r: ScheduledReportTiming, timeZone: string): Period {
  const to = lastSlotIn(now, r, timeZone);
  return { key: periodKey(to, r, timeZone), from: previousSlot(to, r, timeZone), to };
}

/** The report's repositories as merges and reviews name them; undefined for every one. */
async function scopeOf(
  data: Scoped,
  repoIds: readonly string[] | null,
  platforms: readonly PlatformAddress[],
): Promise<RepoScope | undefined> {
  if (repoIds === null) return undefined;
  const repos = await data.scheduledReports.repos(repoIds);
  const identities = repos.flatMap((r) => {
    const base =
      platforms.find((p) => p.kind === r.platform && p.host === r.host)?.url ?? `https://${r.host}`;
    try {
      return [repoIdentity({ url: base }, r.fullName).toLowerCase()];
    } catch {
      return [];
    }
  });
  return { repoIds: repos.map((r) => r.id), identities };
}

const has = (r: ReportOf, s: ReportSection) => r.sections.includes(s);

/** The report's message for the period, and whether the period had no reviews and no merges. */
export async function reportMessage(
  data: Scoped,
  report: ReportOf,
  p: Period,
  ctx: { timeZone: string; share: boolean; platforms: readonly PlatformAddress[]; origin: string },
): Promise<{ message: Message; empty: boolean }> {
  const scope = await scopeOf(data, report.repoIds, ctx.platforms);
  const numbersWanted = has(report, "outcomes") || has(report, "top_repos");
  const [digest, numbers, merges, times] = await Promise.all([
    data.notify.digestOf(p.from, p.to, ctx.share, scope),
    numbersWanted ? data.reports.numbersOf(p.from, p.to, ctx.share, scope) : undefined,
    data.closedPulls.mergedBetween(p.from, p.to, has(report, "merged") ? MERGED_TITLES : 0, scope),
    has(report, "time_to_merge")
      ? data.closedPulls.mergeTimes(p.from, p.to, MAX_MERGE_TIMES, scope)
      : [],
  ]);
  const name = plain(report.name);
  const from = localDate(p.from, ctx.timeZone);
  const to = localDate(new Date(p.to.getTime() - 1), ctx.timeZone);
  const dates = from === to ? from : `${from} to ${to}`;
  const pulls = digest.pulls > 0 ? ` of ${plural(digest.pulls, "pull request")}` : "";
  const reviews = `${plural(digest.reviews, "review")}${pulls}`;
  const lines: Message["lines"] = [[`ocra's report ${name}, ${dates} (${plain(ctx.timeZone)})`]];
  if (has(report, "reviews")) {
    lines.push([`Reviews: ${reviews}`]);
    lines.push([
      `${digest.critical} critical · ${digest.warning} warning · ${digest.suggestion} suggestion`,
    ]);
  }
  if (numbers && has(report, "outcomes")) {
    const open = numbers.open === null ? "" : ` · ${numbers.open} still open`;
    lines.push([`${numbers.fixed} fixed · ${numbers.dismissed} dismissed${open}`]);
  }
  if (has(report, "open_findings") && digest.open.length > 0) {
    lines.push(["Still open:"]);
    for (const f of digest.open)
      lines.push([`• ${f.severity}: ${plain(f.title)} (${plain(f.file)})`]);
  }
  if (has(report, "merged")) {
    lines.push([`Merged: ${plural(merges.merged, "pull request")}`], ...mergedLines(merges));
  }
  if (has(report, "time_to_merge")) {
    const median = quantile(
      [...times].sort((a, b) => a - b),
      0.5,
    );
    lines.push([`Median time to merge: ${median === null ? "none merged" : span(median)}`]);
  }
  if (numbers && has(report, "top_repos") && numbers.topRepos.length > 0) {
    const top = numbers.topRepos.map((r) => `${plain(repoName(r.repo))} (${r.reviews})`);
    lines.push([`Most reviewed: ${top.join(", ")}`]);
  }
  lines.push([
    { label: "Reviews", url: `${ctx.origin}/reviews` },
    " · ",
    { label: "Findings", url: `${ctx.origin}/findings` },
    " · ",
    { label: "Insights", url: `${ctx.origin}/insights` },
  ]);
  return {
    message: {
      event: "scheduled_report",
      subject: `ocra report ${name}, ${dates}: ${reviews}, ${merges.merged} merged`,
      lines,
    },
    empty: digest.reviews === 0 && merges.merged === 0,
  };
}

/** The message as text, links by their labels: what a preview shows. */
export function previewOf(
  p: Period,
  m: { message: Message; empty: boolean },
): ScheduledReportPreview {
  return {
    period: { key: p.key, from: p.from.toISOString(), to: p.to.toISOString() },
    subject: m.message.subject,
    lines: m.message.lines.map((l) => l.map((x) => (typeof x === "string" ? x : x.label)).join("")),
    empty: m.empty,
  };
}

/** Sends the message to the report's confirmed channels; how many took it at once, of how many. */
export async function sendToChannels(
  data: Scoped,
  out: Outbox,
  channelIds: readonly string[],
  message: Message,
): Promise<{ delivered: number; channels: number }> {
  const channels = await data.scheduledReports.channels(channelIds);
  const sent = await Promise.all(channels.map((ch) => send(data, out, ch, message)));
  return { delivered: sent.filter(Boolean).length, channels: channels.length };
}

type Due = Awaited<ReturnType<typeof enabledReports>>[number];

/** Sends the report's due period unless it went already; whether it was sent. */
async function sendDue(
  db: Db,
  out: Outbox,
  platforms: readonly PlatformAddress[],
  due: Due,
  now: Date,
): Promise<boolean> {
  const { report, timeZone } = due;
  const p = lastPeriod(now, report, timeZone);
  const age = now.getTime() - p.to.getTime();
  if (age >= DAY || p.to.getTime() < report.updatedAt.getTime()) return false;
  const data = scoped(db, report.accountId);
  const claim = await data.scheduledReports.claim({ reportId: report.id, period: p.key, ...p });
  if (!claim) return false;
  const made = await reportMessage(data, report, p, {
    timeZone,
    share: keepsStored(due),
    platforms,
    origin: out.origin,
  });
  if (made.empty) return false;
  const { channels } = await sendToChannels(data, out, report.channelIds, made.message);
  await data.scheduledReports.settle(claim, channels);
  return channels > 0;
}

/** Every due scheduled report, an account's one after another; one that fails is logged and the rest still go. */
export async function runScheduledReports(
  db: Db,
  out: Outbox,
  platforms: readonly PlatformAddress[],
  now = new Date(),
  calls?: CallBudget,
): Promise<void> {
  const byAccount = new Map<string, Due[]>();
  for (const due of await enabledReports(db)) {
    const list = byAccount.get(due.report.accountId) ?? [];
    list.push(due);
    byAccount.set(due.report.accountId, list);
  }
  await forAccounts(
    [...byAccount.values()],
    "scheduled_report_failed",
    async (reports) => {
      for (const due of reports) {
        if (calls && !calls.has()) return;
        await sendDue(db, out, platforms, due, now).catch((e) =>
          logError("scheduled_report_failed", { error: errorName(e) }),
        );
      }
    },
    calls,
  );
}

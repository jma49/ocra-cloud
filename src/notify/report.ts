import { quantile } from "../cycles.js";
import type { Db } from "../db/client.js";
import { type ReportSchedule, reportAccounts } from "../db/reports.js";
import { scoped } from "../db/scoped.js";
import { DAY, HOUR, MINUTE, utcDay, utcDayStart } from "../time.js";
import { type Message, plain } from "./channels.js";
import { forAccounts, type Merges, mergedLines, plural } from "./digest.js";
import { type Outbox, send } from "./notify.js";

// The weekly report: the seven days before each account's slot (a UTC
// weekday and hour), sent to the channels that take it once per slot
// whichever host and process runs it, and however often. A slot is due
// for a day after it, so a schedule set mid-week waits for its next slot
// rather than sending an old week; a week without reviews or merges sends
// nothing. Like the digest, the slot is claimed before anything is sent.

const WEEK = 7 * DAY;
const MERGED_TITLES = 5;
/** Merge times a median is taken over: the newest. */
const MAX_MERGE_TIMES = 1000;

/** The latest slot at or before now. */
export function lastSlot(now: Date, s: ReportSchedule): Date {
  const today = utcDayStart(now).getTime();
  for (let back = 0; ; back++) {
    const at = today - back * DAY + s.hour * HOUR;
    if (new Date(at).getUTCDay() === s.weekday && at <= now.getTime()) return new Date(at);
  }
}

/** The first slot after now. */
export const nextSlot = (now: Date, s: ReportSchedule): Date =>
  new Date(lastSlot(now, s).getTime() + WEEK);

/** A duration as a person reads it: days and hours, hours and minutes, or minutes. */
export function span(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type Week = {
  from: string;
  to: string;
  reviews: number;
  pulls: number;
  critical: number;
  warning: number;
  suggestion: number;
  fixed: number;
  dismissed: number;
  open: number | null;
  openTitles: { title: string; file: string; severity: string }[];
  topRepos: { repo: string; reviews: number }[];
  merges: Merges;
  medianToMerge: number | null;
};

/** A repository's address as its path, `octo/api`. */
function repoName(address: string): string {
  try {
    return new URL(address).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || address;
  } catch {
    return address;
  }
}

function reportMessage(w: Week, origin: string): Message {
  const pulls = w.pulls > 0 ? ` of ${plural(w.pulls, "pull request")}` : "";
  const reviews = `${plural(w.reviews, "review")}${pulls}`;
  const open = w.open === null ? "" : ` · ${w.open} still open`;
  const median = w.medianToMerge === null ? "" : ` · median time to merge ${span(w.medianToMerge)}`;
  const top = w.topRepos.map((r) => `${plain(repoName(r.repo))} (${r.reviews})`).join(", ");
  return {
    event: "weekly_report",
    subject: `ocra weekly report, ${w.from} to ${w.to}: ${reviews}, ${w.merges.merged} merged`,
    lines: [
      [`ocra's week from ${w.from} to ${w.to} (UTC): ${reviews}`],
      [`${w.critical} critical · ${w.warning} warning · ${w.suggestion} suggestion`],
      [`${w.fixed} fixed · ${w.dismissed} dismissed${open}`],
      [`Merged: ${plural(w.merges.merged, "pull request")}${median}`],
      ...mergedLines(w.merges),
      ...(top ? [[`Most reviewed: ${top}`]] : []),
      ...(w.openTitles.length > 0 ? [["Still open:"]] : []),
      ...w.openTitles.map((f) => [`• ${f.severity}: ${plain(f.title)} (${plain(f.file)})`]),
      [
        { label: "Reviews", url: `${origin}/reviews` },
        " · ",
        { label: "Findings", url: `${origin}/findings` },
        " · ",
        { label: "Insights", url: `${origin}/insights` },
      ],
    ],
  };
}

/** Sends one account's report of the week before its due slot, unless it went already; whether it was sent. */
async function sendReport(
  db: Db,
  out: Outbox,
  account: { id: string } & ReportSchedule,
  now: Date,
): Promise<boolean> {
  const to = lastSlot(now, account);
  if (now.getTime() - to.getTime() >= DAY) return false;
  const from = new Date(to.getTime() - WEEK);
  const data = scoped(db, account.id);
  const claimed = await data.reports.claim(to);
  if (!claimed) return false;
  const share = claimed.shareFindings;
  const [digest, numbers, merges, times] = await Promise.all([
    data.notify.digestOf(from, to, share),
    data.reports.numbersOf(from, to, share),
    data.closedPulls.mergedBetween(from, to, MERGED_TITLES),
    data.closedPulls.mergeTimes(from, to, MAX_MERGE_TIMES),
  ]);
  if (digest.reviews === 0 && merges.merged === 0) return false;
  const channels = await data.notify.reporting();
  const m = reportMessage(
    {
      from: utcDay(from),
      to: utcDay(new Date(to.getTime() - 1)),
      reviews: digest.reviews,
      pulls: digest.pulls,
      critical: digest.critical,
      warning: digest.warning,
      suggestion: digest.suggestion,
      openTitles: digest.open,
      ...numbers,
      merges,
      medianToMerge: quantile(
        [...times].sort((a, b) => a - b),
        0.5,
      ),
    },
    out.origin,
  );
  await Promise.all(channels.map((ch) => send(data, out, ch, m)));
  return channels.length > 0;
}

/** Every due account's weekly report; one that fails is logged and the rest still go. */
export async function runReports(db: Db, out: Outbox, now = new Date()): Promise<void> {
  await forAccounts(await reportAccounts(db), "report_failed", (a) => sendReport(db, out, a, now));
}

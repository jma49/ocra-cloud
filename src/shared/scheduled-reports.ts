// Reports an account defines (GET /api/scheduled-reports): a name, when it
// goes in the account's time zone, which repositories it counts, which of
// the digest's and weekly report's sections it holds, and the channels it
// goes to. Each covers the time since its previous slot, and goes once per
// period.

/** daily at an hour; weekly on a weekday at an hour; monthly on a day (1-28) at an hour. */
export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
type ReportCadence = (typeof REPORT_CADENCES)[number];

/**
 * reviews: how many, of how many pull requests, by severity. outcomes:
 * findings later runs saw fixed or dismissed, and how many are still open.
 * open_findings: up to five critical or warning ones still open. merged:
 * the pull requests merged, naming the newest five. time_to_merge: their
 * median time from opened to merged. top_repos: the three repositories
 * with the most reviews. Finding titles and open counts need the account
 * to share findings.
 */
export const REPORT_SECTIONS = [
  "reviews",
  "outcomes",
  "open_findings",
  "merged",
  "time_to_merge",
  "top_repos",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** Reports an account may define. */
export const MAX_SCHEDULED_REPORTS = 10;
/** Repositories a report may name. */
export const MAX_REPORT_REPOS = 50;
/** Channels a report may go to; an account has at most 10. */
export const MAX_REPORT_CHANNELS = 10;

export type ScheduledReportTiming = {
  cadence: ReportCadence;
  /** 0-23, in the account's time zone. */
  hour: number;
  /** 0 (Sunday) to 6; weekly only, null otherwise. */
  weekday: number | null;
  /** 1 to 28; monthly only, null otherwise. */
  monthDay: number | null;
};

/** The report as it is saved (POST, PUT) and answered. */
type ScheduledReportInput = ScheduledReportTiming & {
  name: string;
  enabled: boolean;
  /** Enrolled repositories' ids; null counts every repository. */
  repoIds: string[] | null;
  /** In REPORT_SECTIONS' order, each once. */
  sections: ReportSection[];
  /** Channels of the account, never a webhook (reports are for people). */
  channelIds: string[];
};

export type ScheduledReportView = ScheduledReportInput & {
  id: string;
  /** The next slot, ISO 8601, in the account's time zone (timeZone). */
  next: string;
  timeZone: string;
  /** The newest period sent, and when; null before the first. */
  lastSent: { period: string; at: string; channels: number } | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledReportsView = { reports: ScheduledReportView[]; max: number };

/**
 * What a report holds for one period, as text, without sending it
 * (POST /api/scheduled-reports/preview, or /:id/preview): the period in
 * progress, from the latest slot to now. empty: no reviews and no merges, which a slot does
 * not send.
 */
export type ScheduledReportPreview = {
  period: { key: string; from: string; to: string };
  subject: string;
  lines: string[];
  empty: boolean;
};

/** POST /api/scheduled-reports/:id/send: the preview's period sent now; channels that took it at once. */
export type ScheduledReportSent = ScheduledReportPreview & { delivered: number; channels: number };

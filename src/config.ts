// The Worker's numeric settings (wrangler.jsonc `vars`), parsed from their
// string values once per environment object.

export type Config = {
  /** Gateway calls an account may make per UTC day. */
  gatewayDailyCalls: number;
  /** Review uploads an account may make per UTC day. */
  reviewDailyUploads: number;
  /** Shared findings an account may send within the retention window (deleted ones count). */
  reviewMaxFindings: number;
  /** Login codes (ocra login) the whole service may make per UTC day. */
  deviceDailyCodes: number;
  /** Login codes one network (an IPv4 address, an IPv6 /64) may ask for per UTC day. */
  deviceDailyCodesPerNetwork: number;
  /** Days the daily retention keeps an account's records (RETENTION_DAYS). */
  retentionDays: number;
};

type Vars = Record<
  | "GATEWAY_DAILY_CALLS"
  | "REVIEW_DAILY_UPLOADS"
  | "REVIEW_MAX_FINDINGS"
  | "DEVICE_DAILY_CODES"
  | "DEVICE_DAILY_CODES_PER_NETWORK",
  string
> & { RETENTION_DAYS?: string };

const parsed = new WeakMap<Vars, Config>();

export function config(env: Vars): Config {
  let c = parsed.get(env);
  if (!c) {
    c = {
      gatewayDailyCalls: Number(env.GATEWAY_DAILY_CALLS),
      reviewDailyUploads: Number(env.REVIEW_DAILY_UPLOADS),
      reviewMaxFindings: Number(env.REVIEW_MAX_FINDINGS),
      deviceDailyCodes: Number(env.DEVICE_DAILY_CODES),
      deviceDailyCodesPerNetwork: Number(env.DEVICE_DAILY_CODES_PER_NETWORK),
      retentionDays: retentionDaysOf(env.RETENTION_DAYS),
    };
    parsed.set(env, c);
  }
  return c;
}

/** What the data policy (web /privacy) promises the hosted service keeps. */
export const DEFAULT_RETENTION_DAYS = 90;
// At least the longest fixed window of src/db/retention.ts (30 days), so no
// record is kept longer than the retention said.
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

/** RETENTION_DAYS: a whole number of days in 30..3650, DEFAULT_RETENTION_DAYS when unset; throws on anything else. */
export function retentionDaysOf(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_RETENTION_DAYS;
  const days = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!(days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS)) {
    throw new Error(
      `RETENTION_DAYS must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}, not ${raw}`,
    );
  }
  return days;
}

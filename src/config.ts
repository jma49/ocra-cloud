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
};

type Vars = Record<
  | "GATEWAY_DAILY_CALLS"
  | "REVIEW_DAILY_UPLOADS"
  | "REVIEW_MAX_FINDINGS"
  | "DEVICE_DAILY_CODES"
  | "DEVICE_DAILY_CODES_PER_NETWORK",
  string
>;

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
    };
    parsed.set(env, c);
  }
  return c;
}

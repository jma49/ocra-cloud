import type { AppBindings } from "../types.js";
import { memoryRateLimit } from "./limits.js";

// A self-hosted server's settings come from its environment variables, with
// the same names and defaults as the Worker's (wrangler.jsonc), and the same
// rate limits, kept in memory.

const SECRETS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "MASTER_KEY",
  "SESSION_SECRET",
] as const;

const DEFAULTS = {
  GATEWAY_DAILY_CALLS: "500",
  REVIEW_DAILY_UPLOADS: "50",
  REVIEW_MAX_FINDINGS: "1000",
  DEVICE_DAILY_CODES_PER_NETWORK: "20",
  DEVICE_DAILY_CODES: "1000",
} as const;

/** The app's bindings from `vars`; throws naming every required variable that is missing. */
export function bindingsFrom(vars: Record<string, string | undefined>): AppBindings {
  const missing = SECRETS.filter((name) => !vars[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const pick = (name: keyof typeof DEFAULTS) => vars[name] || DEFAULTS[name];
  return {
    GITHUB_CLIENT_ID: vars.GITHUB_CLIENT_ID as string,
    GITHUB_CLIENT_SECRET: vars.GITHUB_CLIENT_SECRET as string,
    MASTER_KEY: vars.MASTER_KEY as string,
    ...(vars.MASTER_KEY_PREVIOUS ? { MASTER_KEY_PREVIOUS: vars.MASTER_KEY_PREVIOUS } : {}),
    SESSION_SECRET: vars.SESSION_SECRET as string,
    ...(vars.GITLAB_CLIENT_ID ? { GITLAB_CLIENT_ID: vars.GITLAB_CLIENT_ID } : {}),
    ...(vars.GITLAB_CLIENT_SECRET ? { GITLAB_CLIENT_SECRET: vars.GITLAB_CLIENT_SECRET } : {}),
    ...(vars.GITLAB_URL ? { GITLAB_URL: vars.GITLAB_URL } : {}),
    GATEWAY_DAILY_CALLS: pick("GATEWAY_DAILY_CALLS"),
    REVIEW_DAILY_UPLOADS: pick("REVIEW_DAILY_UPLOADS"),
    REVIEW_MAX_FINDINGS: pick("REVIEW_MAX_FINDINGS"),
    DEVICE_DAILY_CODES_PER_NETWORK: pick("DEVICE_DAILY_CODES_PER_NETWORK"),
    DEVICE_DAILY_CODES: pick("DEVICE_DAILY_CODES"),
    DEVICE_CODES: memoryRateLimit(10, 60),
    DEVICE_LOOKUPS: memoryRateLimit(20, 60),
    ACCOUNT_CALLS: memoryRateLimit(120, 60),
  };
}

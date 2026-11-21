import { catalogOf } from "../catalog.js";
import type { AppBindings } from "../types.js";
import { memoryRateLimit } from "./limits.js";

// A self-hosted server's settings come from its environment variables, with
// the same names and defaults as the Worker's (wrangler.jsonc), and the same
// rate limits, kept in memory.

const SECRETS = ["MASTER_KEY", "SESSION_SECRET"] as const;

const SIGN_IN = {
  GitHub: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  "OpenID Connect": ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
} as const;

const OPTIONAL = [
  ...SIGN_IN.GitHub,
  ...SIGN_IN["OpenID Connect"],
  "OIDC_NAME",
  "MASTER_KEY_PREVIOUS",
  "GITLAB_CLIENT_ID",
  "GITLAB_CLIENT_SECRET",
  "GITLAB_URL",
  "MODEL_ENDPOINTS",
  "BUILTIN_PROVIDERS",
] as const;

const DEFAULTS = {
  GATEWAY_DAILY_CALLS: "500",
  REVIEW_DAILY_UPLOADS: "50",
  REVIEW_MAX_FINDINGS: "1000",
  DEVICE_DAILY_CODES_PER_NETWORK: "20",
  DEVICE_DAILY_CODES: "1000",
} as const;

/**
 * The app's bindings from `vars`; throws naming every required variable that
 * is missing, when no way to sign in is complete, and on malformed model
 * endpoints.
 */
export function bindingsFrom(vars: Record<string, string | undefined>): AppBindings {
  const missing = SECRETS.filter((name) => !vars[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const ways = Object.values(SIGN_IN);
  if (!ways.some((names) => names.every((name) => vars[name]))) {
    const sets = Object.entries(SIGN_IN).map(([way, names]) => `${way} (${names.join(", ")})`);
    throw new Error(`no way to sign in: set ${sets.join(" or ")}`);
  }
  const pick = (name: keyof typeof DEFAULTS) => vars[name] || DEFAULTS[name];
  const optional = Object.fromEntries(
    OPTIONAL.flatMap((name) => (vars[name] ? [[name, vars[name]]] : [])),
  ) as Partial<Record<(typeof OPTIONAL)[number], string>>;
  catalogOf(optional);
  return {
    ...optional,
    MASTER_KEY: vars.MASTER_KEY as string,
    SESSION_SECRET: vars.SESSION_SECRET as string,
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

/** TRUSTED_PROXY_HOPS: a whole number of proxies, 0 when unset; throws on anything else. */
export function trustedProxyHops(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value))
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number, not ${value}`);
  return Number(value);
}

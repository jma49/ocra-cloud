import { createPrivateKey } from "node:crypto";
import { botSettingsFrom, gitlabReviews, runnerTokenFrom } from "../auto-review/remote.js";
import { catalogOf } from "../catalog.js";
import { graphPolicy } from "../graph/policy.js";
import { githubHostOf } from "../platforms/registry.js";
import { startingModels } from "../preferences.js";
import { allowEntriesOf } from "../sign-in-allow.js";
import type { AppBindings } from "../types.js";
import { rateLimits } from "./limits.js";

// A self-hosted server's settings come from its environment variables, with
// the same names and defaults as the Worker's (wrangler.jsonc), and the same
// rate limits, kept in memory until the host counts them in its database.

const SECRETS = ["MASTER_KEY", "SESSION_SECRET"] as const;

const SIGN_IN = {
  GitHub: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  "OpenID Connect": ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
} as const;

const OPTIONAL = [
  ...SIGN_IN.GitHub,
  "GITHUB_APP_SLUG",
  "GITHUB_URL",
  ...SIGN_IN["OpenID Connect"],
  "OIDC_NAME",
  "SIGN_IN_ALLOW",
  "MASTER_KEY_PREVIOUS",
  "GITLAB_CLIENT_ID",
  "GITLAB_CLIENT_SECRET",
  "GITLAB_URL",
  "MODEL_ENDPOINTS",
  "BUILTIN_PROVIDERS",
  "DEFAULT_MODELS",
  "PUBLIC_URL",
  "SLACK_BOT_TOKEN",
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
 * endpoints or default models.
 */
export function bindingsFrom(vars: Record<string, string | undefined>): AppBindings {
  const missing = SECRETS.filter((name) => !vars[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  for (const name of ["MASTER_KEY", "MASTER_KEY_PREVIOUS"] as const) {
    const value = vars[name];
    if (value !== undefined && value !== "" && !isAesKey(value)) {
      throw new Error(`${name} must be base64 of 32 random bytes (openssl rand -base64 32)`);
    }
  }
  const ways = Object.values(SIGN_IN);
  if (!ways.some((names) => names.every((name) => vars[name]))) {
    const sets = Object.entries(SIGN_IN).map(([way, names]) => `${way} (${names.join(", ")})`);
    throw new Error(`no way to sign in: set ${sets.join(" or ")}`);
  }
  const pick = (name: keyof typeof DEFAULTS) => vars[name] || DEFAULTS[name];
  const optional = Object.fromEntries(
    OPTIONAL.flatMap((name) => (vars[name] ? [[name, vars[name]]] : [])),
  ) as Partial<Record<(typeof OPTIONAL)[number], string>>;
  const bindings: AppBindings = {
    ...optional,
    MASTER_KEY: vars.MASTER_KEY as string,
    SESSION_SECRET: vars.SESSION_SECRET as string,
    GATEWAY_DAILY_CALLS: pick("GATEWAY_DAILY_CALLS"),
    REVIEW_DAILY_UPLOADS: pick("REVIEW_DAILY_UPLOADS"),
    REVIEW_MAX_FINDINGS: pick("REVIEW_MAX_FINDINGS"),
    DEVICE_DAILY_CODES_PER_NETWORK: pick("DEVICE_DAILY_CODES_PER_NETWORK"),
    DEVICE_DAILY_CODES: pick("DEVICE_DAILY_CODES"),
    ...rateLimits("memory"),
  };
  // Read once here so that a malformed GITHUB_URL, MODEL_ENDPOINTS,
  // BUILTIN_PROVIDERS, DEFAULT_MODELS or SIGN_IN_ALLOW stops the server at
  // start, not at a request.
  githubHostOf(bindings);
  startingModels(bindings);
  allowEntriesOf(bindings.SIGN_IN_ALLOW);
  return bindings;
}

/**
 * What the server warns of at start: a model endpoint with the server's own
 * key, which every account calls through the gateway, on a server anyone
 * the sign-in providers vouch for may sign in to.
 */
export function startWarnings(bindings: AppBindings): string[] {
  const shared = catalogOf(bindings).entries.filter(([, p]) => p.sharedKey);
  if (shared.length === 0 || allowEntriesOf(bindings.SIGN_IN_ALLOW)) return [];
  return ["open_sign_in_with_server_key"];
}

// Checked at start: a malformed key would otherwise surface only when the
// first provider key is stored or opened.
function isAesKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=?$/.test(value) && Buffer.from(value, "base64").length === 32;
}

// Checked at start: a wrong id or key would otherwise surface as a failed
// first review, after a pull request was already waiting on it.
function checkGithubApp(id: string | undefined, key: string | undefined): void {
  if (!id || !key) {
    throw new Error("GitHub auto review needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  }
  if (!/^\d+$/.test(id)) throw new Error(`GITHUB_APP_ID must be the App's number, not ${id}`);
  try {
    createPrivateKey(key);
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is not a PEM private key (\\n for line breaks on one line)",
    );
  }
}

/** TRUSTED_PROXY_HOPS: a whole number of proxies, 0 when unset; throws on anything else. */
export function trustedProxyHops(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value))
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number, not ${value}`);
  return Number(value);
}

/** METRICS_TOKEN: what GET /metrics asks for as a bearer; none (metrics off) when unset. */
export function metricsTokenFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length < 32 || /\s/.test(value)) {
    throw new Error(
      "METRICS_TOKEN must be at least 32 characters, no spaces (openssl rand -hex 32)",
    );
  }
  return value;
}

/** MIGRATE: on (the default) applies the migrations at start, off leaves them, only applies them and exits. */
export function migrateMode(value: string | undefined): "on" | "off" | "only" {
  if (!value) return "on";
  if (value === "on" || value === "off" || value === "only") return value;
  throw new Error(`MIGRATE must be on, off or only, not ${value}`);
}

/** CODE_GRAPH and GRAPH_WORKERS (builds at once, 1 when unset). */
export function graphSettingsFrom(vars: Record<string, string | undefined>) {
  const workers = vars.GRAPH_WORKERS || "1";
  if (!/^[1-9]\d*$/.test(workers)) {
    throw new Error(`GRAPH_WORKERS must be a whole number above 0, not ${workers}`);
  }
  return {
    policy: graphPolicy(vars.CODE_GRAPH),
    workers: Number(workers),
  };
}

/**
 * AUTO_REVIEW_WORKERS (reviews at once; 1 when unset, 0 to only queue them)
 * and the ocra bot's credentials: GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY,
 * GITLAB_BOT_TOKEN. Off without any credential, except that a server with
 * the GitLab application and PUBLIC_URL reviews the projects given their
 * own access token. RUNNER_TOKEN lets remote runners take jobs too
 * (docs/runner.md).
 */
export function autoReviewSettingsFrom(vars: Record<string, string | undefined>) {
  const bots = botSettingsFrom(vars);
  const github = !!bots.githubAppId || !!bots.githubAppPrivateKey;
  if (github) checkGithubApp(bots.githubAppId, bots.githubAppPrivateKey);
  // Without PUBLIC_URL a server that would review only projects' own tokens stays as it was.
  const gitlab = !!bots.gitlabBotToken || (gitlabReviews(vars) && !!vars.PUBLIC_URL);
  if (!github && !gitlab) return undefined;
  const workers = vars.AUTO_REVIEW_WORKERS || "1";
  if (!/^\d+$/.test(workers)) {
    throw new Error(`AUTO_REVIEW_WORKERS must be a whole number, not ${workers}`);
  }
  const runnerToken = runnerTokenFrom(vars.RUNNER_TOKEN);
  return { bots, workers: Number(workers), ...(runnerToken ? { runnerToken } : {}) };
}

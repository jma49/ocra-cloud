import type { ErrorCode } from "@open-cr-agent/cloud-contract";
import type {
  ProviderGroup,
  ReviewerCounts,
  ReviewSource,
  RiskTier,
  Verdict,
} from "../../src/shared/index.js";

export type Me = { login: string; githubId: number; session: "web" | "cli"; since: string };
export type ProviderInfo = {
  name: string;
  label: string;
  group: ProviderGroup;
  base: string;
  paths: string[];
};
export type CheckStatus = "ok" | "invalid" | "error" | "unchecked";
export type Key = {
  provider: string;
  last4: string;
  createdAt: string;
  checkStatus: CheckStatus | null;
  checkedAt: string | null;
  checkable: boolean;
  lastUsedAt: string | null;
  calls7d: number;
};
export type KeyCheck = { status: CheckStatus; httpStatus?: number };
type Call = {
  id: string;
  provider: string;
  path: string;
  model: string | null;
  status: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  createdAt: string;
};
export type Day = {
  day: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
  byModel: Record<string, { calls: number; tokens: number }>;
};
export type Usage = {
  days: number;
  today: number;
  dailyLimit: number;
  series: Day[];
  models: { model: string; provider: string; calls: number; tokensIn: number; tokensOut: number }[];
  calls: Call[];
};
export type Session = {
  id: string;
  kind: "web" | "cli";
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
};

/** A refusal; `code` is undefined when the answer names no code this app knows (a proxy's page, say). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | undefined,
  ) {
    super(code ?? String(status));
  }
}

const SIGNED_OUT = "you are signed out; sign in again in a new tab";
const NOT_ALLOWED = "this session may not do that";
const GONE = "it no longer exists";
const TOO_MANY = "too many requests; wait a moment and try again";
const SERVER = "ocra Cloud had an error; try again";
const REFUSED = "the request was refused";

/** Every code ocra Cloud answers, in words for the person (no codes). */
export const MESSAGES: Record<ErrorCode, string> = {
  invalid_body: REFUSED,
  body_too_large: REFUSED,
  unauthenticated: SIGNED_OUT,
  bad_origin: NOT_ALLOWED,
  forbidden_for_session: NOT_ALLOWED,
  not_found: GONE,
  daily_limit: TOO_MANY,
  stale: REFUSED,
  version_no_longer_valid: REFUSED,
  memory_full: REFUSED,
  unknown_provider: GONE,
  no_key: GONE,
  path_not_allowed: GONE,
  upstream_unreachable: SERVER,
  upstream_redirect: SERVER,
  confirm_with_login: REFUSED,
  bad_state: REFUSED,
  github_exchange: SERVER,
  github_user: SERVER,
  unknown_or_expired: GONE,
  already_decided: REFUSED,
  internal: SERVER,
  invalid_request: REFUSED,
  invalid_grant: REFUSED,
  expired_token: REFUSED,
  authorization_pending: REFUSED,
  // From the web, only the device page's lookup limit (429).
  slow_down: TOO_MANY,
  access_denied: REFUSED,
};

function codeOf(error: unknown): ErrorCode | undefined {
  return typeof error === "string" && Object.hasOwn(MESSAGES, error)
    ? (error as ErrorCode)
    : undefined;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new ApiError(res.status, codeOf(body.error));
  return body as T;
}

/** Why a request failed, in words for the person (no codes). */
export function why(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code) return MESSAGES[e.code];
    if (e.status === 401) return SIGNED_OUT;
    if (e.status === 403) return NOT_ALLOWED;
    if (e.status === 404) return GONE;
    if (e.status === 429) return TOO_MANY;
    if (e.status >= 500) return SERVER;
    return REFUSED;
  }
  return "ocra Cloud could not be reached; check your connection";
}

export type Review = {
  id: string;
  runId: string;
  repo: string;
  source: ReviewSource;
  tier: RiskTier | null;
  verdict: Verdict | null;
  complete: boolean;
  findings: number;
  critical: number;
  warning: number;
  suggestion: number;
  filesReviewed: number;
  filesNotReviewed: number;
  tasksCompleted: number;
  tasksFailed: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  ocraVersion: string | null;
  createdAt: string;
};
export type Reviews = {
  days: number;
  summary: {
    reviews: number;
    repositories: number;
    findings: number;
    critical: number;
    blocking: number;
    incomplete: number;
    fixed: number;
    dismissed: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  reviewers: Record<
    string,
    ReviewerCounts & { findingsTotal: number; acceptanceRate: number | null }
  >;
  reviews: Review[];
};

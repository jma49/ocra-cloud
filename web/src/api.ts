import type { ErrorCode } from "@open-cr-agent/cloud-contract";
import type {
  CodePlatformKind,
  GraphPolicy,
  ProviderGroup,
  ReviewerCounts,
  ReviewSource,
  RiskTier,
  Verdict,
} from "../../src/shared/index.js";
import {
  PLATFORM_RATE_LIMITED,
  RECENT_SIGN_IN,
  RECENT_SIGN_IN_MINUTES,
} from "../../src/shared/index.js";

export type Me = {
  login: string;
  githubId: number | null;
  /** The web address of this server's GitHub, where it has one. */
  githubUrl: string | null;
  avatarUrl: string | null;
  session: "web" | "cli";
  since: string;
  /** What this server does with code graphs; off where it builds none. */
  codeGraphs: GraphPolicy;
  /** Whether this server reviews enrolled repositories' pull requests itself. */
  autoReview: boolean;
  /** The code platforms this server can connect. */
  platforms: readonly CodePlatformKind[];
};
export type ProviderInfo = {
  name: string;
  label: string;
  group: ProviderGroup;
  base: string;
  paths: string[];
  /** The server holds this provider's key; accounts store none. */
  managed?: boolean;
};
export type CheckStatus = "ok" | "invalid" | "error" | "unchecked";
export type Key = {
  provider: string;
  /** The server's own key: nothing to replace or delete, and no last4 or date. */
  managed: boolean;
  last4: string | null;
  createdAt: string | null;
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

export type BodyIssue = { path: (string | number)[]; message: string };

function issuesOf(body: { issues?: unknown }): BodyIssue[] {
  if (!Array.isArray(body.issues)) return [];
  return body.issues.flatMap((i: unknown) => {
    const { path, message } = (i ?? {}) as { path?: unknown; message?: unknown };
    return Array.isArray(path) && typeof message === "string" ? [{ path, message }] : [];
  });
}

/** A refusal; `code` is undefined when the answer names no code this app knows (a proxy's page, say). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | undefined,
    /** What some refusals add to their code (RECENT_SIGN_IN). */
    readonly reason?: string,
    /** Where an invalid_body did not fit: each path into the body, and why. */
    readonly issues: readonly BodyIssue[] = [],
    /** When a refusal for a used-up allowance lifts (ISO time). */
    readonly retryAt?: string,
    /** How the CLI words a file an invalid_body refused, and whether there were more issues than listed. */
    readonly file: { refusal?: string; more?: boolean } = {},
  ) {
    super(code ?? String(status));
  }
}

/** A refusal that a fresh sign-in would lift (audit C7). */
export function needsSignIn(e: unknown): boolean {
  return e instanceof ApiError && e.reason === RECENT_SIGN_IN;
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
  // From the web: the device page's lookup limit, and an account's
  // per-minute limit on key checks and settings saves (429).
  slow_down: TOO_MANY,
  access_denied: REFUSED,
};

function codeOf(error: unknown): ErrorCode | undefined {
  return typeof error === "string" && Object.hasOwn(MESSAGES, error)
    ? (error as ErrorCode)
    : undefined;
}

// Reads started ahead of the page that makes them (on a link's hover, or
// with the navigation), each taken once by the first matching GET within
// EARLY_MS; one nobody takes is dropped.
const EARLY_MS = 10_000;
const early = new Map<string, { at: number; answer: Promise<unknown> }>();

/** One spelling for a path whatever order its query was built in. */
function readKey(path: string): string {
  const url = new URL(path, "http://x");
  url.searchParams.sort();
  return url.pathname + url.search;
}

/** Starts the GET of `path` now, for the page about to read it. */
export function prefetch(path: string): void {
  const key = readKey(path);
  const was = early.get(key);
  if (was && Date.now() - was.at < EARLY_MS) return;
  const answer = request(path, {});
  answer.catch(() => {});
  early.set(key, { at: Date.now(), answer });
}

function takeEarly(path: string): Promise<unknown> | undefined {
  const key = readKey(path);
  const was = early.get(key);
  if (!was) return undefined;
  early.delete(key);
  return Date.now() - was.at < EARLY_MS ? was.answer : undefined;
}

/** Forgets reads started ahead (sign-out, and tests). */
export function forgetPrefetched(): void {
  early.clear();
}

export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const read = (init.method ?? "GET") === "GET" && init.body === undefined;
  return ((read && takeEarly(path)) || request(path, init)) as Promise<T>;
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    reason?: unknown;
    issues?: unknown;
    retryAt?: unknown;
    refusal?: unknown;
    more?: unknown;
  };
  if (!res.ok) {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const retryAt = typeof body.retryAt === "string" ? body.retryAt : undefined;
    const file = {
      ...(typeof body.refusal === "string" ? { refusal: body.refusal } : {}),
      ...(body.more === true ? { more: true } : {}),
    };
    throw new ApiError(res.status, codeOf(body.error), reason, issuesOf(body), retryAt, file);
  }
  return body;
}

/** Why a request failed, in words for the person (no codes). */
export function why(e: unknown): string {
  if (e instanceof ApiError) {
    if (needsSignIn(e)) {
      return `this needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes; sign in again, then retry`;
    }
    if (e.reason === PLATFORM_RATE_LIMITED) {
      const at = e.retryAt ? new Date(e.retryAt) : null;
      const time =
        at && !Number.isNaN(at.getTime())
          ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : null;
      return `the code platform's hourly allowance of requests for your account is used up; try again${time ? ` after ${time}` : " later"}`;
    }
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
  /** The name the account gave the repository, if any. */
  name?: string | null;
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
  /** The pull request a PR-mode review was of; null or absent for other reviews. */
  prNumber?: number | null;
  prHeadSha?: string | null;
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

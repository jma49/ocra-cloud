import type { CodePlatformKind, FindingStatus, Severity, Verdict } from "./domain.js";
import type { PullItem } from "./pulls.js";

// The console's search (⌘K): what GET /api/search answers, how a query is
// normalised and read as a pull request's reference, and the console's
// destinations, which the web can match without asking the server.

const MAX_SEARCH_QUERY = 100;
export const SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

/** Trimmed, control characters dropped, runs of space as one, at most MAX_SEARCH_QUERY characters. */
export function normaliseSearchQuery(raw: string): string {
  const clean = raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...clean].slice(0, MAX_SEARCH_QUERY).join("").trim();
}

/** A query that names one pull request: `#123`, `owner/repo#123` or GitLab's `group/project!123`. */
export type PullReference = { repo: string | null; number: number };

const REFERENCE = /^(?:([\w.-]+(?:\/[\w.-]+)+)[#!]|#)(\d{1,9})$/;

export function pullReferenceOf(query: string): PullReference | null {
  const m = REFERENCE.exec(query);
  if (!m?.[2]) return null;
  const number = Number(m[2]);
  return number >= 1 ? { repo: m[1] ?? null, number } : null;
}

/** A page of the console the search can jump to. */
export type SearchDestination = {
  label: string;
  to: string;
  /** Its place or settings group, which the search matches too. */
  within: string;
  /** More words it is found by. */
  keywords: readonly string[];
  /** Shown only when the deployment runs that feature. */
  needs?: "autoReview" | "codeGraphs";
};

const SEARCH_DESTINATIONS: readonly SearchDestination[] = [
  { label: "Inbox", to: "/", within: "Inbox", keywords: ["pull requests", "home"] },
  { label: "Reviews", to: "/reviews", within: "Reviews", keywords: ["runs", "history"] },
  { label: "Activity", to: "/activity", within: "Reviews", keywords: ["timeline"] },
  { label: "Live", to: "/live", within: "Reviews", keywords: ["running", "watch"] },
  { label: "Findings", to: "/findings", within: "Findings", keywords: ["issues", "bugs"] },
  { label: "Repositories", to: "/repositories", within: "Repositories", keywords: ["repos"] },
  {
    label: "Code graphs",
    to: "/code-graphs",
    within: "Repositories",
    keywords: ["symbols", "impact"],
    needs: "codeGraphs",
  },
  {
    label: "Auto review",
    to: "/auto-review",
    within: "Repositories",
    keywords: ["enroll", "webhook"],
    needs: "autoReview",
  },
  { label: "Learnings", to: "/learnings", within: "Repositories", keywords: ["lessons"] },
  { label: "Memory", to: "/memory", within: "Repositories", keywords: ["remembered"] },
  { label: "Overview", to: "/insights", within: "Insights", keywords: ["insights", "stats"] },
  { label: "Usage", to: "/usage", within: "Insights", keywords: ["tokens", "cost", "spend"] },
  { label: "Agents & models", to: "/agents", within: "Review", keywords: ["reviewers", "model"] },
  { label: "Review settings", to: "/review-settings", within: "Review", keywords: ["tier"] },
  { label: "Rules", to: "/rules", within: "Review", keywords: ["checks", "policy"] },
  { label: "Automations", to: "/automations", within: "Review", keywords: ["triggers"] },
  { label: "Plugins", to: "/plugins", within: "Review", keywords: ["extensions"] },
  { label: "Defaults & history", to: "/defaults", within: "Review", keywords: ["versions"] },
  { label: "Provider keys", to: "/keys", within: "Models & spend", keywords: ["api key"] },
  { label: "Budget", to: "/budget", within: "Models & spend", keywords: ["limit", "spend"] },
  {
    label: "Account & privacy",
    to: "/settings",
    within: "Account",
    keywords: ["sharing", "export", "delete", "platforms", "connect"],
  },
  { label: "Notifications", to: "/notifications", within: "Account", keywords: ["email", "chat"] },
  { label: "CLI & sessions", to: "/sessions", within: "Account", keywords: ["login", "devices"] },
];

/** The destinations every word of the query is found in, for a deployment with these features. */
export function matchDestinations(
  query: string,
  features: { autoReview: boolean; codeGraphs: boolean },
  limit = MAX_SEARCH_LIMIT,
): SearchDestination[] {
  const words = query.toLowerCase().split(" ").filter(Boolean);
  return SEARCH_DESTINATIONS.filter((d) => !d.needs || features[d.needs])
    .filter((d) => {
      const text = [d.label, d.within, ...d.keywords].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .slice(0, limit);
}

/** A pull request's page in the console; the repository's slashes travel encoded in one segment. */
export const pullPath = (platform: CodePlatformKind, repo: string, number: number) =>
  `/pull/${platform}/${encodeURIComponent(repo)}/${number}`;

export type SearchPullResult = Omit<PullItem, "roles" | "labels" | "verdict"> & {
  platform: CodePlatformKind;
  host: string;
  to: string;
};

/** One connected platform's pull requests; `error` when it did not answer in time or refused. */
export type SearchPlatformPulls = {
  platform: CodePlatformKind;
  host: string;
  linked: boolean;
  error: "unavailable" | null;
  results: SearchPullResult[];
};

export type SearchReviewResult = {
  id: string;
  /** The repository's name, as the account named it or its pull request review said; null when unknown. */
  repo: string | null;
  prNumber: number | null;
  verdict: Verdict | null;
  findings: number;
  createdAt: string;
  to: string;
};

export type SearchFindingResult = {
  id: string;
  reviewId: string;
  title: string;
  file: string;
  line: number | null;
  severity: Severity;
  status: FindingStatus;
  to: string;
};

export type SearchRepositoryResult = {
  platform: CodePlatformKind;
  host: string;
  fullName: string;
  autoReview: boolean;
  codeGraph: boolean;
  to: string;
};

export type SearchResultsView = {
  /** The query as it was searched, after normaliseSearchQuery. */
  query: string;
  /** The one pull request a reference like `owner/repo#123` named, when it was found. */
  jump: SearchPullResult | null;
  pulls: SearchPlatformPulls[];
  reviews: SearchReviewResult[];
  /** null while the account does not share findings: none are kept, none are searched. */
  findings: SearchFindingResult[] | null;
  repositories: SearchRepositoryResult[];
  destinations: SearchDestination[];
};

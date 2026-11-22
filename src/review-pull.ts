import type { Row } from "./db/scoped.js";
import { type CodePlatform, repoIdentity } from "./platforms/platform.js";

// The pull request a PR-mode review was of (ADR-0038), read back from what
// the CLI uploaded: checked part by part before anything acts on it.

const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

export type ReviewPull = { host: string; repo: string; number: number; head: string };

/** Its host, its repository's path, its number and the head reviewed; null for another review. */
export function pullOfReview(review: Row<"reviews">): ReviewPull | null {
  const { prRepository, prNumber, prHeadSha } = review;
  if (!prRepository || !prNumber || !prHeadSha) return null;
  const at = repoOfIdentity(prRepository);
  if (!at) return null;
  return { ...at, number: prNumber, head: prHeadSha };
}

/** The host and path of a repository named `https://host/path`, checked part by part; null when it is not one. */
export function repoOfIdentity(identity: string): { host: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(identity);
  } catch {
    return null;
  }
  const repo = url.pathname.slice(1);
  const parts = repo.split("/");
  if (url.protocol !== "https:" || url.port || parts.length < 2 || repo.length > 255) return null;
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  return { host: url.hostname, repo };
}

/**
 * The configured platform the pull request is on, and the pull request with
 * its repository's path there: the CLI writes the host without a port, and
 * the path under the relative root of an instance installed under one.
 */
export function pullOnPlatform(
  platforms: readonly CodePlatform[],
  pull: ReviewPull,
): { platform: CodePlatform; pull: ReviewPull } | undefined {
  for (const platform of platforms) {
    if (platform.host.replace(/:\d+$/, "").toLowerCase() !== pull.host) continue;
    const root = new URL(platform.url).pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!root) return { platform, pull };
    if (pull.repo.toLowerCase().startsWith(`${root}/`)) {
      return { platform, pull: { ...pull, repo: pull.repo.slice(root.length + 1) } };
    }
  }
  return undefined;
}

/** The pull request's page on its platform. */
export function pullPageUrl(platform: CodePlatform, pull: Pick<ReviewPull, "repo" | "number">) {
  const base = `${platform.url}/${pull.repo}`;
  return platform.kind === "gitlab"
    ? `${base}/-/merge_requests/${pull.number}`
    : `${base}/pull/${pull.number}`;
}

/** The CLI's name for the repository, or null for one the platform's address cannot name. */
export function identityOf(platform: CodePlatform, repo: string): string | null {
  try {
    return repoIdentity(platform, repo);
  } catch {
    return null;
  }
}

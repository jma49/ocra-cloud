import type { Row } from "./db/scoped.js";
import type { CodePlatform } from "./platforms/platform.js";

// The pull request a PR-mode review was of (ADR-0038), read back from what
// the CLI uploaded: checked part by part before anything acts on it.

const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

export type ReviewPull = { host: string; repo: string; number: number; head: string };

/** Its host, its repository's path, its number and the head reviewed; null for another review. */
export function pullOfReview(review: Row<"reviews">): ReviewPull | null {
  const { prRepository, prNumber, prHeadSha } = review;
  if (!prRepository || !prNumber || !prHeadSha) return null;
  let url: URL;
  try {
    url = new URL(prRepository);
  } catch {
    return null;
  }
  const repo = url.pathname.slice(1);
  const parts = repo.split("/");
  if (url.protocol !== "https:" || url.port || parts.length < 2 || repo.length > 255) return null;
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  return { host: url.hostname, repo, number: prNumber, head: prHeadSha };
}

/** The configured platform the pull request is on; the CLI writes its host without a port. */
export const platformOfPull = (platforms: readonly CodePlatform[], pull: ReviewPull) =>
  platforms.find((p) => p.host.replace(/:\d+$/, "").toLowerCase() === pull.host);

/** The pull request's page on its platform. */
export function pullPageUrl(platform: CodePlatform, pull: ReviewPull): string {
  const base = `https://${platform.host}/${pull.repo}`;
  return platform.kind === "gitlab"
    ? `${base}/-/merge_requests/${pull.number}`
    : `${base}/pull/${pull.number}`;
}

import { z } from "zod";

// Which webhook deliveries change what the inbox shows of a pull request:
// the pull request itself, its reviews and threads, a comment on it, and a
// finished check suite or merge request pipeline of it. A check of a
// branch with no pull request does not, so a busy default branch never
// makes the inbox read the platforms again.

const GITHUB_PULL_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
]);

const githubComment = z.object({ issue: z.object({ pull_request: z.object({}).loose() }) });
const githubSuite = z.object({
  action: z.literal("completed"),
  check_suite: z.object({ pull_requests: z.array(z.unknown()).min(1) }),
});
const gitlabOfMergeRequest = z.object({ merge_request: z.object({}).loose() });

export function githubTouchesPulls(event: string, body: unknown): boolean {
  if (GITHUB_PULL_EVENTS.has(event)) return true;
  if (event === "issue_comment") return githubComment.safeParse(body).success;
  if (event === "check_suite") return githubSuite.safeParse(body).success;
  return false;
}

export function gitlabTouchesPulls(kind: string | undefined, body: unknown): boolean {
  if (kind === "Merge Request Hook") return true;
  if (kind === "Note Hook" || kind === "Pipeline Hook") {
    return gitlabOfMergeRequest.safeParse(body).success;
  }
  return false;
}

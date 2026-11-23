import { z } from "zod";
import type { PullChangeKind } from "./shared/index.js";

// Which webhook deliveries change what the inbox shows of a pull request:
// the pull request itself, its reviews and threads, a comment on it, and a
// finished check suite or merge request pipeline of it. A check of a
// branch with no pull request does not, so a busy default branch never
// makes the inbox read the platforms again.

/** What a delivery changed of the repository's pull requests, and which ones it names. */
export type PullsTouched = { kind: PullChangeKind; numbers: number[] };

/** Pull requests one delivery may name to open consoles: a check suite names every pull of its head. */
const MAX_NUMBERS = 10;

const GITHUB_PULL_EVENTS: Record<string, PullChangeKind> = {
  pull_request: "pull",
  pull_request_review: "review",
  pull_request_review_thread: "review",
  pull_request_review_comment: "comment",
};

const number = z.number().int().min(1);
const githubNumbered = z.object({
  pull_request: z.object({ number }).optional(),
  number: number.optional(),
});
const githubComment = z.object({
  issue: z.object({ number: number.optional(), pull_request: z.object({}).loose() }),
});
const githubSuite = z.object({
  action: z.literal("completed"),
  check_suite: z.object({
    pull_requests: z.array(z.object({ number: number.optional() }).loose()).min(1),
  }),
});
const gitlabOfMergeRequest = z.object({
  merge_request: z.object({ iid: number.optional() }).loose(),
});
const gitlabMergeRequest = z.object({ object_attributes: z.object({ iid: number }).loose() });

const numbersOf = (all: (number | undefined)[]) =>
  [...new Set(all.filter((n): n is number => n !== undefined))].slice(0, MAX_NUMBERS);

export function githubPullsTouched(event: string, body: unknown): PullsTouched | null {
  const kind = GITHUB_PULL_EVENTS[event];
  if (kind) {
    const named = githubNumbered.safeParse(body);
    const n = named.success ? (named.data.pull_request?.number ?? named.data.number) : undefined;
    return { kind, numbers: numbersOf([n]) };
  }
  if (event === "issue_comment") {
    const comment = githubComment.safeParse(body);
    return comment.success
      ? { kind: "comment", numbers: numbersOf([comment.data.issue.number]) }
      : null;
  }
  if (event === "check_suite") {
    const suite = githubSuite.safeParse(body);
    if (!suite.success) return null;
    return {
      kind: "checks",
      numbers: numbersOf(suite.data.check_suite.pull_requests.map((p) => p.number)),
    };
  }
  return null;
}

export function gitlabPullsTouched(kind: string | undefined, body: unknown): PullsTouched | null {
  if (kind === "Merge Request Hook") {
    const mr = gitlabMergeRequest.safeParse(body);
    return {
      kind: "pull",
      numbers: numbersOf([mr.success ? mr.data.object_attributes.iid : undefined]),
    };
  }
  if (kind === "Note Hook" || kind === "Pipeline Hook") {
    const of = gitlabOfMergeRequest.safeParse(body);
    if (!of.success) return null;
    return {
      kind: kind === "Note Hook" ? "comment" : "checks",
      numbers: numbersOf([of.data.merge_request.iid]),
    };
  }
  return null;
}

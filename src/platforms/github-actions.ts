import type { LineSide, PullVerdict } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { platformCall, platformSend } from "./http.js";

const API = "https://api.github.com";

const EVENT = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const satisfies Record<PullVerdict, string>;

const SIDE = { old: "LEFT", new: "RIGHT" } as const satisfies Record<LineSide, string>;

export function githubActions(): PullActions {
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend(url, {
      method,
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const repo = (fullName: string) => `${API}/repos/${githubRepoPath(fullName)}`;
  return {
    verdicts: ["approve", "request_changes", "comment"],
    mergeMethods: ["merge", "squash", "rebase"],
    async comment(token, fullName, number, body) {
      return outcomeOf(
        await send(token, "POST", `${repo(fullName)}/issues/${number}/comments`, { body }),
      );
    },
    async review(token, fullName, number, review) {
      const pull = await platformCall<{ head: { sha: string } }>(
        `${repo(fullName)}/pulls/${number}`,
        { headers: githubHeaders(token) },
      );
      if (!pull) return null;
      // GitHub takes a review of an older commit; a verdict on code the user did not see is not one.
      if (pull.head.sha !== review.head) return "head_moved";
      return outcomeOf(
        await send(token, "POST", `${repo(fullName)}/pulls/${number}/reviews`, {
          commit_id: review.head,
          event: EVENT[review.verdict],
          ...(review.body ? { body: review.body } : {}),
          comments: review.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: SIDE[c.side],
            body: c.body,
          })),
        }),
      );
    },
    async merge(token, fullName, number, merge) {
      return outcomeOf(
        await send(token, "PUT", `${repo(fullName)}/pulls/${number}/merge`, {
          merge_method: merge.method,
          sha: merge.head,
        }),
        { 405: "not_mergeable", 409: "head_moved" },
      );
    },
  };
}

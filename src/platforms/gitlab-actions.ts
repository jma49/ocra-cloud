import type { LineComment } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";

// GitLab has no "request changes" a client can set: its verdicts here are
// approve and comment. A review is several calls (each line comment is a
// discussion, then the note, then the approval), stopped at the first refusal.

type MergeRequest = { sha: string; diff_refs: DiffRefs | null };

const positionOf = (refs: DiffRefs, c: LineComment) => ({
  position_type: "text",
  base_sha: refs.base_sha,
  start_sha: refs.start_sha,
  head_sha: refs.head_sha,
  new_path: c.path,
  old_path: c.path,
  ...(c.side === "new" ? { new_line: c.line } : { old_line: c.line }),
});

export function gitlabActions(origin: string): PullActions {
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend(url, {
      method,
      headers: { ...gitlabHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    verdicts: ["approve", "comment"],
    mergeMethods: ["merge", "squash"],
    async comment(token, fullName, number, body) {
      const mr = mergeRequestUrl(origin, fullName, number);
      return outcomeOf(await send(token, "POST", `${mr}/notes`, { body }));
    },
    async review(token, fullName, number, review) {
      const url = mergeRequestUrl(origin, fullName, number);
      const mr = await platformCall<MergeRequest>(url, { headers: gitlabHeaders(token) });
      if (!mr?.diff_refs) return null;
      if (mr.sha !== review.head) return "head_moved";
      for (const c of review.comments) {
        const posted = outcomeOf(
          await send(token, "POST", `${url}/discussions`, {
            body: c.body,
            position: positionOf(mr.diff_refs, c),
          }),
        );
        if (posted !== "done") return posted;
      }
      if (review.body) {
        const noted = outcomeOf(await send(token, "POST", `${url}/notes`, { body: review.body }));
        if (noted !== "done") return noted;
      }
      if (review.verdict !== "approve") return "done";
      return outcomeOf(await send(token, "POST", `${url}/approve`, { sha: review.head }), {
        409: "head_moved",
      });
    },
    async merge(token, fullName, number, merge) {
      const url = mergeRequestUrl(origin, fullName, number);
      return outcomeOf(
        await send(token, "PUT", `${url}/merge`, {
          sha: merge.head,
          squash: merge.method === "squash",
        }),
        { 405: "not_mergeable", 406: "not_mergeable", 409: "head_moved" },
      );
    },
  };
}

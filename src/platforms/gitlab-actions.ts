import type { LineComment } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { fixedFile, fromBase64, MAX_FIX_FILE_BYTES, toBase64 } from "./fix.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";

// GitLab has no "request changes" a client can set: its verdicts here are
// approve and comment. A review is several calls (each line comment is a
// discussion, then the note, then the approval), stopped at the first refusal.

type MergeRequest = {
  sha: string;
  diff_refs: DiffRefs | null;
  source_branch: string;
  source_project_id: number;
};
type File = { size: number; encoding: string; content: string; last_commit_id: string };

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
    async addLabels(token, fullName, number, labels) {
      const mr = mergeRequestUrl(origin, fullName, number);
      return outcomeOf(await send(token, "PUT", mr, { add_labels: labels.join(",") }));
    },
    async requestReviewers(token, fullName, number, logins) {
      const headers = { headers: gitlabHeaders(token) };
      const url = mergeRequestUrl(origin, fullName, number);
      const mr = await platformCall<{ reviewers?: { id: number }[] }>(url, headers);
      if (!mr) return null;
      // GitLab names reviewers by id, and sets them all at once: the ones it has are kept.
      const found = await Promise.all(
        logins.map((login) =>
          platformCall<{ id: number }[]>(
            `${origin}/api/v4/users?username=${encodeURIComponent(login)}`,
            headers,
          ),
        ),
      );
      const ids = found.flatMap((users) => users?.[0]?.id ?? []);
      if (ids.length === 0) return "refused";
      const kept = (mr.reviewers ?? []).map((r) => r.id);
      return outcomeOf(
        await send(token, "PUT", url, { reviewer_ids: [...new Set([...kept, ...ids])] }),
      );
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
    async applyFix(token, fullName, number, commit) {
      const headers = { headers: gitlabHeaders(token) };
      const url = mergeRequestUrl(origin, fullName, number);
      const mr = await platformCall<MergeRequest>(url, headers);
      if (!mr) return null;
      if (mr.sha !== commit.head) return "head_moved";
      // The branch is in the project the merge request came from, a fork's included.
      const project = `${origin}/api/v4/projects/${mr.source_project_id}/repository`;
      const path = encodeURIComponent(commit.path);
      const read = await platformCall<File>(`${project}/files/${path}?ref=${commit.head}`, headers);
      if (!read) return null;
      if (read.encoding !== "base64" || read.size > MAX_FIX_FILE_BYTES) return "not_applicable";
      const bytes = fromBase64(read.content);
      const fixed = bytes && fixedFile(bytes, commit.fix);
      if (!fixed) return "not_applicable";
      // last_commit_id: GitLab refuses the commit when the file changed since it was read.
      return outcomeOf(
        await send(token, "POST", `${project}/commits`, {
          branch: mr.source_branch,
          commit_message: commit.message,
          actions: [
            {
              action: "update",
              file_path: commit.path,
              content: toBase64(fixed),
              encoding: "base64",
              last_commit_id: read.last_commit_id,
            },
          ],
        }),
      );
    },
  };
}

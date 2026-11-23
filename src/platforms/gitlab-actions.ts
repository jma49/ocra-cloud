import type { LineComment, MergeMethod } from "../shared/index.js";
import { outcomeOf, type PullActions, plannedFixes, unsent } from "./actions.js";
import { fromBase64, MAX_FIX_FILE_BYTES, toBase64 } from "./fix.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { gitlabUserIds } from "./gitlab-roster.js";
import { platformCall, platformSend } from "./http.js";
import { withSuggestion } from "./suggestions.js";

// GitLab has no "request changes" a client can set: its verdicts here are
// approve and comment. A review is several calls (each line comment is a
// discussion, then the note, then the approval), stopped at the first refusal.

type MergeRequest = {
  sha: string;
  diff_refs: DiffRefs | null;
  source_branch: string;
  source_project_id: number;
};
type ProjectSettings = { merge_method?: string; squash_option?: string };

/** A fast-forward project merges without a merge commit, as a rebase does. */
const UNSQUASHED = new Map<string, MergeMethod>([
  ["merge", "merge"],
  ["rebase_merge", "merge"],
  ["ff", "rebase"],
]);

/** The project's merge methods, its default first: squash_option says whether, and when, it squashes. */
function methodsOf(settings: ProjectSettings): MergeMethod[] | null {
  const plain = UNSQUASHED.get(settings.merge_method ?? "");
  if (!plain) return null;
  switch (settings.squash_option) {
    case "never":
      return [plain];
    case "always":
      return ["squash"];
    case "default_on":
      return ["squash", plain];
    default:
      return [plain, "squash"];
  }
}

type Described = { sha: string; description: string | null };
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
  const description = async (token: string, fullName: string, number: number) => {
    const url = mergeRequestUrl(origin, fullName, number);
    const mr = await platformCall<Described>(url, { headers: gitlabHeaders(token) });
    return mr && { head: mr.sha, body: mr.description ?? "" };
  };
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
            // A range is anchored on its last line; a suggestion reaches up to its start.
            body:
              c.suggestion === undefined
                ? c.body
                : withSuggestion("gitlab", c.body, c.suggestion, c.line - (c.startLine ?? c.line)),
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
      const found = await gitlabUserIds(origin, token, logins);
      if (!found) return null;
      const ids = found.filter((id) => id !== null);
      if (ids.length === 0) return "refused";
      const kept = (mr.reviewers ?? []).map((r) => r.id);
      return outcomeOf(
        await send(token, "PUT", url, { reviewer_ids: [...new Set([...kept, ...ids])] }),
      );
    },
    async allowedMergeMethods(token, fullName) {
      const project = await platformCall<ProjectSettings>(
        `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`,
        { headers: gitlabHeaders(token) },
      );
      return project && methodsOf(project);
    },
    async merge(token, fullName, number, merge) {
      // A merge and a rebase are both sent unsquashed: the project's merge_method decides which it is.
      const url = mergeRequestUrl(origin, fullName, number);
      return outcomeOf(
        await send(token, "PUT", `${url}/merge`, {
          sha: merge.head,
          squash: merge.method === "squash",
        }),
        { 405: "not_mergeable", 406: "not_mergeable", 409: "head_moved" },
      );
    },
    async applyFixes(token, fullName, number, commit) {
      const headers = { headers: gitlabHeaders(token) };
      const url = mergeRequestUrl(origin, fullName, number);
      const mr = await platformCall<MergeRequest>(url, headers);
      if (!mr) return null;
      if (mr.sha !== commit.head) return unsent("head_moved", commit.files);
      // The branch is in the project the merge request came from, a fork's included.
      const project = `${origin}/api/v4/projects/${mr.source_project_id}/repository`;
      const reads: (File | null)[] = [];
      for (const f of commit.files) {
        const path = encodeURIComponent(f.path);
        reads.push(
          await platformCall<File>(`${project}/files/${path}?ref=${commit.head}`, headers),
        );
      }
      if (reads.some((r) => r === null)) return null;
      const plan = plannedFixes(
        reads.map((read) =>
          read?.encoding === "base64" && read.size <= MAX_FIX_FILE_BYTES
            ? fromBase64(read.content)
            : undefined,
        ),
        commit,
      );
      const { skipped } = plan;
      if (!plan.send) return { outcome: "not_applicable", skipped };
      const lastCommit = new Map(commit.files.map((f, i) => [f.path, reads[i]?.last_commit_id]));
      // last_commit_id: GitLab refuses the commit when a file changed since it was read.
      const outcome = outcomeOf(
        await send(token, "POST", `${project}/commits`, {
          branch: mr.source_branch,
          commit_message: plan.message,
          actions: plan.changed.map((f) => ({
            action: "update",
            file_path: f.path,
            content: toBase64(f.content),
            encoding: "base64",
            last_commit_id: lastCommit.get(f.path),
          })),
        }),
      );
      return outcome && { outcome, skipped };
    },
    description,
    async setDescription(token, fullName, number, edit) {
      // GitLab has no head guard on an edit: the head is read just before, as a review's is.
      const now = await description(token, fullName, number);
      if (!now) return null;
      if (now.head !== edit.head) return "head_moved";
      const url = mergeRequestUrl(origin, fullName, number);
      return outcomeOf(await send(token, "PUT", url, { description: edit.body }));
    },
  };
}

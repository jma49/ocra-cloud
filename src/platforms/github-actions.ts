import type { LineSide, MergeMethod, PullVerdict } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { fixedFile, fromBase64, MAX_FIX_FILE_BYTES, toBase64 } from "./fix.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { platformCall, platformSend } from "./http.js";
import { withSuggestion } from "./suggestions.js";

const API = "https://api.github.com";

const EVENT = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const satisfies Record<PullVerdict, string>;

const SIDE = { old: "LEFT", new: "RIGHT" } as const satisfies Record<LineSide, string>;

/** GitHub has no default method: they are listed in the order its own merge button lists them. */
const ALLOWS = [
  ["merge", "allow_merge_commit"],
  ["squash", "allow_squash_merge"],
  ["rebase", "allow_rebase_merge"],
] as const satisfies readonly (readonly [MergeMethod, string])[];

type RepoSettings = Partial<Record<(typeof ALLOWS)[number][1], boolean>>;
type Pull = { head: { sha: string; ref: string; repo: { full_name: string } | null } };
type PullBody = { head: { sha: string }; body: string | null };
type File = { type: string; sha: string; size: number; encoding?: string; content?: string };

export function githubActions(): PullActions {
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend(url, {
      method,
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const repo = (fullName: string) => `${API}/repos/${githubRepoPath(fullName)}`;
  const description = async (token: string, fullName: string, number: number) => {
    const url = `${repo(fullName)}/pulls/${number}`;
    const pull = await platformCall<PullBody>(url, { headers: githubHeaders(token) });
    return pull && { head: pull.head.sha, body: pull.body ?? "" };
  };
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
            ...(c.startLine !== undefined && c.startLine < c.line
              ? { start_line: c.startLine, start_side: SIDE[c.side] }
              : {}),
            body:
              c.suggestion === undefined
                ? c.body
                : withSuggestion("github", c.body, c.suggestion, 0),
          })),
        }),
      );
    },
    async addLabels(token, fullName, number, labels) {
      return outcomeOf(
        await send(token, "POST", `${repo(fullName)}/issues/${number}/labels`, { labels }),
      );
    },
    async requestReviewers(token, fullName, number, logins) {
      return outcomeOf(
        await send(token, "POST", `${repo(fullName)}/pulls/${number}/requested_reviewers`, {
          reviewers: logins,
        }),
      );
    },
    async allowedMergeMethods(token, fullName) {
      const settings = await platformCall<RepoSettings>(repo(fullName), {
        headers: githubHeaders(token),
      });
      // A setting GitHub left out of its answer is not known.
      if (!settings || ALLOWS.some(([, key]) => typeof settings[key] !== "boolean")) return null;
      return ALLOWS.flatMap(([method, key]) => (settings[key] ? [method] : []));
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
    async applyFix(token, fullName, number, commit) {
      const headers = { headers: githubHeaders(token) };
      const pull = await platformCall<Pull>(`${repo(fullName)}/pulls/${number}`, headers);
      if (!pull) return null;
      if (pull.head.sha !== commit.head) return "head_moved";
      // The branch is in the fork a pull request came from; gone with it, nothing can be committed.
      if (!pull.head.repo) return "refused";
      const file = `${repo(pull.head.repo.full_name)}/contents/${githubRepoPath(commit.path)}`;
      const read = await platformCall<File>(`${file}?ref=${commit.head}`, headers);
      if (!read) return null;
      if (read.type !== "file" || read.encoding !== "base64" || read.size > MAX_FIX_FILE_BYTES) {
        return "not_applicable";
      }
      const bytes = fromBase64(read.content ?? "");
      const fixed = bytes && fixedFile(bytes, commit.fixes);
      if (!fixed) return "not_applicable";
      // sha: the file as it was read; one changed since is a conflict, not overwritten.
      return outcomeOf(
        await send(token, "PUT", file, {
          message: commit.message,
          content: toBase64(fixed),
          sha: read.sha,
          branch: pull.head.ref,
        }),
        { 409: "head_moved" },
      );
    },
    description,
    async setDescription(token, fullName, number, edit) {
      // GitHub has no head guard on an edit: the head is read just before, as a review's is.
      const now = await description(token, fullName, number);
      if (!now) return null;
      if (now.head !== edit.head) return "head_moved";
      return outcomeOf(
        await send(token, "PATCH", `${repo(fullName)}/pulls/${number}`, { body: edit.body }),
      );
    },
  };
}

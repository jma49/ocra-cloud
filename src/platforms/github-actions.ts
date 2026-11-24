import type { LineSide, MergeMethod, PullVerdict } from "../shared/index.js";
import { outcomeOf, type PullActions, plannedFixes, unsent } from "./actions.js";
import { fromBase64, MAX_FIX_FILE_BYTES, toBase64 } from "./fix.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { commitFiles } from "./github-commit.js";
import type { GithubHost } from "./github-host.js";
import { platformCall, platformSend } from "./http.js";
import { withSuggestion } from "./suggestions.js";

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

export function githubActions(host: GithubHost): PullActions {
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend(url, {
      method,
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
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
    async applyFixes(token, fullName, number, commit) {
      const headers = { headers: githubHeaders(token) };
      const pull = await platformCall<Pull>(`${repo(fullName)}/pulls/${number}`, headers);
      if (!pull) return null;
      if (pull.head.sha !== commit.head) return unsent("head_moved", commit.files);
      // The branch is in the fork a pull request came from; gone with it, nothing can be committed.
      const fork = pull.head.repo?.full_name;
      if (!fork) return unsent("refused", commit.files);
      const contents = (path: string) => `${repo(fork)}/contents/${githubRepoPath(path)}`;
      const reads: (File | null)[] = [];
      for (const f of commit.files) {
        reads.push(await platformCall<File>(`${contents(f.path)}?ref=${commit.head}`, headers));
      }
      if (reads.some((r) => r === null)) return null;
      const plan = plannedFixes(
        reads.map((read) =>
          read?.type === "file" && read.encoding === "base64" && read.size <= MAX_FIX_FILE_BYTES
            ? fromBase64(read.content ?? "")
            : undefined,
        ),
        commit,
      );
      const { skipped } = plan;
      if (!plan.send) return { outcome: "not_applicable", skipped };
      const [one] = plan.changed;
      if (plan.changed.length > 1 || !one) {
        const target = { head: commit.head, branch: pull.head.ref, message: plan.message };
        const outcome = await commitFiles(host, token, fork, target, plan.changed);
        return outcome && { outcome, skipped };
      }
      const read = reads[commit.files.findIndex((f) => f.path === one.path)];
      // sha: the file as it was read; one changed since is a conflict, not overwritten.
      const outcome = outcomeOf(
        await send(token, "PUT", contents(one.path), {
          message: plan.message,
          content: toBase64(one.content),
          sha: read?.sha,
          branch: pull.head.ref,
        }),
        { 409: "head_moved" },
      );
      return outcome && { outcome, skipped };
    },
    description,
  };
}

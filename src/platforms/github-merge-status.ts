import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformCall, platformSend } from "./http.js";
import { CHECK_NAME, type PullMergeStatus } from "./merge-status.js";

/** GitHub's longest check run summary. */
const MAX_SUMMARY = 65_535;

type Pull = {
  title: string;
  body: string | null;
  head: { sha: string };
  changed_files: number;
  additions: number;
  deletions: number;
};

export function githubMergeStatus(host: GithubHost): PullMergeStatus {
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  return {
    async facts(token, fullName, number) {
      const pull = await platformCall<Pull>(`${repo(fullName)}/pulls/${number}`, {
        headers: githubHeaders(token),
      });
      if (!pull) return null;
      return {
        title: pull.title,
        description: pull.body ?? "",
        head: pull.head.sha,
        files: pull.changed_files,
        lines: pull.additions + pull.deletions,
        exact: true,
      };
    },
    async publish(token, fullName, head, status, previous) {
      const run = {
        name: CHECK_NAME,
        // A pending result is a check run still in progress, which has no conclusion.
        ...(status.conclusion === "pending"
          ? { status: "in_progress" }
          : { status: "completed", conclusion: status.conclusion }),
        details_url: status.detailsUrl,
        output: { title: status.title, summary: status.summary.slice(0, MAX_SUMMARY) },
      };
      const send = (method: string, url: string, body: unknown) =>
        platformSend<{ id?: unknown }>(url, {
          method,
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      if (previous && /^\d+$/.test(previous)) {
        const updated = await send("PATCH", `${repo(fullName)}/check-runs/${previous}`, run);
        if (updated && updated.status < 300) return previous;
      }
      const created = await send("POST", `${repo(fullName)}/check-runs`, {
        ...run,
        head_sha: head,
      });
      const id = created && created.status < 300 ? created.body?.id : undefined;
      return typeof id === "number" ? String(id) : null;
    },
  };
}

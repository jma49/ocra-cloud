import { lineCounts } from "./changes.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import { CHECK_NAME, type PostedStatus, type PullMergeStatus } from "./merge-status.js";

// GitLab lists no line counts on a merge request: its diffs are read, at
// most MAX_PAGES pages of them. A commit status has no neutral state and
// a one-line description; the console's page holds the rest.

const PER_PAGE = 100;
const MAX_PAGES = 10;
/** GitLab's longest commit status description. */
const MAX_DESCRIPTION = 255;

type MergeRequest = {
  title: string;
  description: string | null;
  sha: string;
  changes_count: string | null;
};
type Diff = { diff: string };

/** A commit status has no neutral: a failing warning shows as success, with its title. */
const STATE = {
  success: "success",
  neutral: "success",
  failure: "failed",
  pending: "pending",
} as const satisfies Record<PostedStatus["conclusion"], string>;

export function gitlabMergeStatus(origin: string): PullMergeStatus {
  return {
    async facts(token, fullName, number) {
      const base = mergeRequestUrl(origin, fullName, number);
      const headers = { headers: gitlabHeaders(token) };
      const mr = await platformCall<MergeRequest>(base, headers);
      if (!mr) return null;
      let files = 0;
      let lines = 0;
      let more = true;
      for (let page = 1; more && page <= MAX_PAGES; page++) {
        const diffs = await platformCall<Diff[]>(
          `${base}/diffs?per_page=${PER_PAGE}&page=${page}`,
          headers,
        );
        if (!diffs) return null;
        files += diffs.length;
        for (const d of diffs) {
          const counted = lineCounts(d.diff);
          lines += counted.additions + counted.deletions;
        }
        more = diffs.length === PER_PAGE;
      }
      // "1000+" when GitLab stopped counting.
      const listed = Number.parseInt(mr.changes_count ?? "", 10);
      return {
        title: mr.title,
        description: mr.description ?? "",
        head: mr.sha,
        files: Math.max(files, Number.isNaN(listed) ? 0 : listed),
        lines,
        exact: !more && !(mr.changes_count ?? "").endsWith("+"),
      };
    },
    async publish(token, fullName, head, status) {
      const posted = await platformSend<{ id?: unknown }>(
        `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/statuses/${head}`,
        {
          method: "POST",
          headers: { ...gitlabHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({
            state: STATE[status.conclusion],
            name: CHECK_NAME,
            description: status.title.slice(0, MAX_DESCRIPTION),
            target_url: status.detailsUrl,
          }),
        },
      );
      const id = posted && posted.status < 300 ? posted.body?.id : undefined;
      return typeof id === "number" ? String(id) : null;
    },
  };
}

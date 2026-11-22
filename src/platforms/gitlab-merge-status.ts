import { lineCounts } from "./changes.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import {
  CHECK_NAME,
  type PostedStatus,
  type PullFacts,
  type PullMergeStatus,
} from "./merge-status.js";

// GitLab lists no line counts on a merge request: its diffs are read, at
// most MAX_PAGES pages of them. A commit status has no neutral state and
// a one-line description; the console's page holds the rest.

const PER_PAGE = 100;
const MAX_PAGES = 10;
/** GitLab's longest commit status description. */
const MAX_DESCRIPTION = 255;

export type MergeRequest = {
  title: string;
  description: string | null;
  sha: string;
  changes_count: string | null;
};
type Diff = { diff: string; new_path: string };
type Diffs = { diffs: Diff[]; more: boolean };

/** The merge request's diffs, at most MAX_PAGES pages of them; null when one page failed. */
export async function readDiffs(base: string, init: RequestInit): Promise<Diffs | null> {
  const diffs: Diff[] = [];
  let more = true;
  for (let page = 1; more && page <= MAX_PAGES; page++) {
    const listed = await platformCall<Diff[]>(
      `${base}/diffs?per_page=${PER_PAGE}&page=${page}`,
      init,
    );
    if (!listed) return null;
    diffs.push(...listed);
    more = listed.length === PER_PAGE;
  }
  return { diffs, more };
}

export function factsOf(mr: MergeRequest, { diffs, more }: Diffs): PullFacts {
  let lines = 0;
  for (const d of diffs) {
    const counted = lineCounts(d.diff);
    lines += counted.additions + counted.deletions;
  }
  // "1000+" when GitLab stopped counting.
  const listed = Number.parseInt(mr.changes_count ?? "", 10);
  return {
    title: mr.title,
    description: mr.description ?? "",
    head: mr.sha,
    files: Math.max(diffs.length, Number.isNaN(listed) ? 0 : listed),
    lines,
    exact: !more && !(mr.changes_count ?? "").endsWith("+"),
  };
}

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
      const diffs = await readDiffs(base, headers);
      return diffs ? factsOf(mr, diffs) : null;
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

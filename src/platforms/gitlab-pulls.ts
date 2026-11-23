import { avatarOf } from "./changes.js";
import { platformCall } from "./http.js";
import {
  type ListedPull,
  labelsOf,
  MERGED_PER_LIST,
  mergedSince,
  OPEN_PER_LIST,
  type PullListing,
  type TeamAsk,
  withRoles,
} from "./pulls.js";

/** Merge requests asked of a group the user is on read at most, newest ask first: one call each. */
const MAX_GROUP_ASKED = 10;

export type MergeRequest = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  author: { username: string; avatar_url?: string | null } | null;
  labels?: string[];
  sha?: string | null;
  source_branch?: string;
  target_branch?: string;
  source_project_id?: number;
  target_project_id?: number;
  references?: { full?: string };
};

export function repoOf(mr: MergeRequest): string {
  const full = mr.references?.full;
  if (full?.includes("!")) return full.slice(0, full.lastIndexOf("!"));
  const path = new URL(mr.web_url).pathname.replace(/^\/+/, "");
  return path.split("/-/")[0] ?? path;
}

export const mergeRequestItem = (mr: MergeRequest): ListedPull => ({
  id: String(mr.id),
  number: mr.iid,
  title: mr.title,
  url: mr.web_url,
  repo: repoOf(mr),
  author: mr.author?.username ?? null,
  authorAvatar: avatarOf(mr.author?.avatar_url),
  draft: Boolean(mr.draft ?? mr.work_in_progress),
  state: mr.state === "merged" ? "merged" : "open",
  createdAt: mr.created_at,
  updatedAt: mr.updated_at,
  mergedAt: mr.merged_at ?? null,
  // The listing has no pipeline, approvals or line counts; one call per MR would.
  checks: null,
  review: null,
  labels: labelsOf(mr.labels ?? []),
  additions: null,
  deletions: null,
  head: mr.sha ?? null,
  branches:
    mr.source_branch &&
    mr.target_branch &&
    mr.source_project_id !== undefined &&
    mr.source_project_id === mr.target_project_id
      ? { head: mr.source_branch, base: mr.target_branch }
      : null,
});

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * The merge requests asking the user's review, theirs open and theirs merged
 * this week. GitLab lists only those naming the user a reviewer, so those an
 * approval rule asks of a group they are on come from teamAsks: each read
 * on its own, listed while still open.
 */
export async function gitlabPulls(
  baseUrl: string,
  token: string,
  teamAsks: readonly TeamAsk[] = [],
  now = Date.now(),
): Promise<PullListing | null> {
  const get = <T>(path: string) =>
    platformCall<T>(`${baseUrl}/api/v4${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  const me = await get<{ id: number }>("/user");
  if (!me) return null;
  const open = `state=opened&order_by=updated_at&per_page=${OPEN_PER_LIST}`;
  const since = encodeURIComponent(mergedSince(now).toISOString());
  const [review, authored, merged] = await Promise.all([
    get<MergeRequest[]>(`/merge_requests?scope=all&reviewer_id=${me.id}&${open}`),
    get<MergeRequest[]>(`/merge_requests?scope=created_by_me&${open}`),
    get<MergeRequest[]>(
      `/merge_requests?scope=created_by_me&state=merged&updated_after=${since}&order_by=updated_at&per_page=${MERGED_PER_LIST}`,
    ),
  ]);
  if (!review || !authored || !merged) return null;
  const listed = new Set([...review, ...authored].map((mr) => keyOf(repoOf(mr), mr.iid)));
  const missed = teamAsks.filter((a) => !listed.has(keyOf(a.repo, a.number)));
  const read = await Promise.all(
    missed
      .slice(-MAX_GROUP_ASKED)
      .map((a) =>
        get<MergeRequest>(`/projects/${encodeURIComponent(a.repo)}/merge_requests/${a.number}`),
      ),
  );
  const groupAsked = read.filter((mr): mr is MergeRequest => mr?.state === "opened");
  return {
    pulls: withRoles([
      { role: "reviewer", pulls: [...review, ...groupAsked].map(mergeRequestItem) },
      { role: "author", pulls: [...authored, ...merged].map(mergeRequestItem) },
    ]),
    more:
      review.length >= OPEN_PER_LIST ||
      authored.length >= OPEN_PER_LIST ||
      missed.length > MAX_GROUP_ASKED,
  };
}

import { platformCall } from "./http.js";
import {
  type ListedPull,
  labelsOf,
  MERGED_PER_LIST,
  mergedSince,
  OPEN_PER_LIST,
  type PullListing,
  withRoles,
} from "./pulls.js";

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
  author: { username: string } | null;
  labels?: string[];
  sha?: string | null;
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
});

export async function gitlabPulls(
  baseUrl: string,
  token: string,
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
  return {
    pulls: withRoles([
      { role: "reviewer", pulls: review.map(mergeRequestItem) },
      { role: "author", pulls: [...authored, ...merged].map(mergeRequestItem) },
    ]),
    more: review.length >= OPEN_PER_LIST || authored.length >= OPEN_PER_LIST,
  };
}

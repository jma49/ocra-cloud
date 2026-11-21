import type { PullItem } from "../shared/index.js";
import { platformCall } from "./http.js";
import { mergeSections, PULLS_PER_SECTION, type PullListing } from "./platform.js";

type MergeRequest = {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  created_at: string;
  updated_at: string;
  author: { username: string } | null;
  references?: { full?: string };
};

function repoOf(mr: MergeRequest): string {
  const full = mr.references?.full;
  if (full?.includes("!")) return full.slice(0, full.lastIndexOf("!"));
  const path = new URL(mr.web_url).pathname.replace(/^\/+/, "");
  return path.split("/-/")[0] ?? path;
}

const item = (mr: MergeRequest): Omit<PullItem, "sections"> => ({
  id: String(mr.id),
  number: mr.iid,
  title: mr.title,
  url: mr.web_url,
  repo: repoOf(mr),
  author: mr.author?.username ?? null,
  draft: Boolean(mr.draft ?? mr.work_in_progress),
  createdAt: mr.created_at,
  updatedAt: mr.updated_at,
  // The listing has no pipeline, approvals or line counts; one call per MR would.
  checks: null,
  review: null,
  additions: null,
  deletions: null,
});

export async function gitlabPulls(baseUrl: string, token: string): Promise<PullListing | null> {
  const get = <T>(path: string) =>
    platformCall<T>(`${baseUrl}/api/v4${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  const me = await get<{ id: number }>("/user");
  if (!me) return null;
  const list = `state=opened&order_by=updated_at&per_page=${PULLS_PER_SECTION}`;
  const [review, authored] = await Promise.all([
    get<MergeRequest[]>(`/merge_requests?scope=all&reviewer_id=${me.id}&${list}`),
    get<MergeRequest[]>(`/merge_requests?scope=created_by_me&${list}`),
  ]);
  if (!review || !authored) return null;
  return {
    pulls: mergeSections([
      { section: "review", pulls: review.map(item) },
      { section: "authored", pulls: authored.map(item) },
    ]),
    more: review.length >= PULLS_PER_SECTION || authored.length >= PULLS_PER_SECTION,
  };
}

import { type MergeRequest, mergeRequestItem } from "./gitlab-pulls.js";
import { platformCall, platformSend } from "./http.js";
import type { ListedPull, PullSearch } from "./pulls.js";

// The merge requests a search finds on GitLab, as the user: those they
// opened, are assigned or review, matching the title's words or the
// number, or the one a reference names. GitLab's scope=all alone would
// search every project the user can see, on gitlab.com every public one.

export async function gitlabSearch(
  baseUrl: string,
  token: string,
  search: PullSearch,
  limit: number,
): Promise<ListedPull[] | null> {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (!("text" in search) && search.repo !== null) {
    const path = `/projects/${encodeURIComponent(search.repo)}/merge_requests/${search.number}`;
    const answer = await platformSend<MergeRequest>(`${baseUrl}/api/v4${path}`, { headers });
    if (answer?.status === 404) return [];
    if (answer?.status !== 200 || !answer.body) return null;
    return [mergeRequestItem(answer.body)];
  }
  const get = <T>(path: string) => platformCall<T>(`${baseUrl}/api/v4${path}`, { headers });
  const me = await get<{ id: number }>("/user");
  if (!me) return null;
  const match =
    "text" in search
      ? `search=${encodeURIComponent(search.text)}&in=title`
      : `iids[]=${search.number}`;
  const common = `${match}&state=all&order_by=updated_at&per_page=${limit}`;
  const lists = await Promise.all([
    get<MergeRequest[]>(`/merge_requests?scope=created_by_me&${common}`),
    get<MergeRequest[]>(`/merge_requests?scope=assigned_to_me&${common}`),
    get<MergeRequest[]>(`/merge_requests?scope=all&reviewer_id=${me.id}&${common}`),
  ]);
  if (lists.some((l) => l === null)) return null;
  const byId = new Map<number, MergeRequest>();
  for (const mr of lists.flatMap((l) => l ?? [])) byId.set(mr.id, mr);
  return [...byId.values()]
    .map(mergeRequestItem)
    .filter((p) => "text" in search || p.number === search.number)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

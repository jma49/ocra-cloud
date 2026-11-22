import {
  type CycleScope,
  firstOther,
  MAX_CYCLE_PULLS,
  type MergedPull,
  type PullCycles,
} from "./cycles.js";
import { type MergeRequest, repoOf } from "./gitlab-pulls.js";
import { platformCall } from "./http.js";

// GitLab lists merged merge requests without their reviews: the first note
// by someone else, one call per merge request, a few at a time.

type Note = { system: boolean; created_at: string; author: { username: string } | null };

const AT_ONCE = 5;

export function gitlabCycles(baseUrl: string): PullCycles {
  return {
    async merged(token, scope: CycleScope, since) {
      const get = <T>(path: string) =>
        platformCall<T>(`${baseUrl}/api/v4${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
      const query = `state=merged&updated_after=${encodeURIComponent(since.toISOString())}&order_by=updated_at&per_page=${MAX_CYCLE_PULLS}`;
      const list = await get<MergeRequest[]>(
        "mine" in scope
          ? `/merge_requests?scope=created_by_me&${query}`
          : `/projects/${encodeURIComponent(scope.repo)}/merge_requests?${query}`,
      );
      if (!list) return null;
      const merged = list.filter(
        (mr): mr is MergeRequest & { merged_at: string } =>
          typeof mr.merged_at === "string" && mr.merged_at >= since.toISOString(),
      );
      const out: MergedPull[] = [];
      for (let i = 0; i < merged.length; i += AT_ONCE) {
        const batch = await Promise.all(
          merged.slice(i, i + AT_ONCE).map(async (mr): Promise<MergedPull> => {
            const repo = repoOf(mr);
            const notes = await get<Note[]>(
              `/projects/${mr.project_id}/merge_requests/${mr.iid}/notes?sort=asc&order_by=created_at&per_page=100`,
            );
            const author = mr.author?.username ?? null;
            const acts = (notes ?? [])
              .filter((n) => !n.system)
              .map((n) => ({ by: n.author?.username ?? null, at: n.created_at }));
            return {
              repo,
              number: mr.iid,
              title: mr.title,
              url: mr.web_url,
              author,
              createdAt: mr.created_at,
              mergedAt: mr.merged_at,
              firstReviewAt: firstOther(author, mr.merged_at, acts),
            };
          }),
        );
        out.push(...batch);
      }
      return out;
    },
  };
}

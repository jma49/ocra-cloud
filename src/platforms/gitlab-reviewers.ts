import { inBatches } from "./files.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformRead } from "./http.js";
import { isBotLogin, LOGIN, type PullReviewers } from "./reviewers.js";

type User = { username: string; bot?: boolean };
type MergeRequest = {
  project_id: number;
  author: User | null;
  diff_refs: DiffRefs | null;
  reviewers?: User[];
};

const LOAD_CONCURRENCY = 4;

export function gitlabReviewers(origin: string): PullReviewers {
  return {
    async people(token, fullName, number) {
      const mr = await platformCall<MergeRequest>(mergeRequestUrl(origin, fullName, number), {
        headers: gitlabHeaders(token),
      });
      if (!mr?.diff_refs) return null;
      return {
        platformRepoId: String(mr.project_id),
        author: mr.author && !mr.author.bot ? mr.author.username : null,
        base: mr.diff_refs.base_sha,
        requested: (mr.reviewers ?? []).map((u) => u.username),
      };
    },
    load(token, logins) {
      return inBatches([...logins], LOAD_CONCURRENCY, async (login) => {
        if (!LOGIN.test(login) || isBotLogin(login)) return null;
        const query = new URLSearchParams({
          state: "opened",
          scope: "all",
          reviewer_username: login,
          per_page: "1",
        });
        // The count is in a header; the one merge request listed is not read.
        return platformRead(
          `${origin}/api/v4/merge_requests?${query}`,
          { headers: gitlabHeaders(token) },
          async (res) => {
            await res.body?.cancel().catch(() => {});
            const total = Number(res.headers.get("x-total"));
            return res.headers.has("x-total") && Number.isInteger(total) ? total : null;
          },
        );
      });
    },
  };
}

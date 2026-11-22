import { outcomeOf } from "./actions.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import type { OpenPull, PullStacks } from "./stacks.js";

const PER_PAGE = 100;

type MergeRequest = {
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  sha: string;
  source_project_id: number;
  target_project_id: number;
};

// The listing has no pipeline or approvals; one call per merge request would.
const openPull = (mr: MergeRequest): OpenPull => ({
  number: mr.iid,
  title: mr.title,
  url: mr.web_url,
  draft: Boolean(mr.draft ?? mr.work_in_progress),
  head: mr.source_branch,
  base: mr.target_branch,
  headSha: mr.sha,
  checks: null,
  review: null,
});

export function gitlabStacks(origin: string): PullStacks {
  return {
    async open(token, fullName) {
      const project = `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
      const listed = await platformCall<MergeRequest[]>(
        `${project}/merge_requests?state=opened&order_by=created_at&per_page=${PER_PAGE}`,
        { headers: gitlabHeaders(token) },
      );
      // A fork's branch of the same name is not this project's branch.
      return (
        listed?.filter((mr) => mr.source_project_id === mr.target_project_id).map(openPull) ?? null
      );
    },
    async retarget(token, fullName, number, base) {
      return outcomeOf(
        await platformSend(mergeRequestUrl(origin, fullName, number), {
          method: "PUT",
          headers: { ...gitlabHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ target_branch: base }),
        }),
      );
    },
  };
}

import { outcomeOf } from "./actions.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import { type LayerStanding, MAX_OPEN_PAGES, type OpenPull, type PullStacks } from "./stacks.js";

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

type Standing = {
  state: "opened" | "closed" | "locked" | "merged";
  sha: string;
  source_branch: string;
  target_branch: string;
  detailed_merge_status?: string;
  head_pipeline?: { status: string } | null;
};

const CONFLICTS = new Set(["conflict", "broken_status"]);
const CHECKS = new Set(["ci_must_pass", "ci_still_running"]);
const FAILED = new Set(["failed", "canceled"]);

function blockerOf(mr: Standing): LayerStanding["blocker"] {
  const status = mr.detailed_merge_status ?? "";
  if (status === "mergeable") return null;
  if (status === "need_rebase") return "behind";
  if (CONFLICTS.has(status)) return "conflicts";
  if (CHECKS.has(status)) {
    return FAILED.has(mr.head_pipeline?.status ?? "") ? "checks_failed" : "checks_pending";
  }
  return "waiting";
}

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
  const listed = (token: string, fullName: string, query: Record<string, string>) => {
    const project = `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
    const params = new URLSearchParams({ state: "opened", per_page: String(PER_PAGE), ...query });
    return platformCall<MergeRequest[]>(`${project}/merge_requests?${params}`, {
      headers: gitlabHeaders(token),
    });
  };
  // A fork's branch of the same name is not this project's branch.
  const own = (mrs: MergeRequest[]) =>
    mrs.filter((mr) => mr.source_project_id === mr.target_project_id).map(openPull);
  return {
    async open(token, fullName) {
      const pulls: OpenPull[] = [];
      for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
        const mrs = await listed(token, fullName, { order_by: "created_at", page: String(page) });
        if (!mrs) return page === 1 ? null : pulls;
        pulls.push(...own(mrs));
        if (mrs.length < PER_PAGE) break;
      }
      return pulls;
    },
    async children(token, fullName, branch) {
      const mrs = await listed(token, fullName, { target_branch: branch });
      return mrs ? own(mrs) : null;
    },
    async standing(token, fullName, number) {
      const mr = await platformCall<Standing>(mergeRequestUrl(origin, fullName, number), {
        headers: gitlabHeaders(token),
      });
      if (!mr) return null;
      return {
        state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
        head: mr.sha,
        headBranch: mr.source_branch,
        base: mr.target_branch,
        blocker: blockerOf(mr),
      };
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

import { CODEOWNERS_PATHS, MAX_CODEOWNERS_BYTES } from "../codeowners.js";
import type { RepoFiles } from "./files.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { type MergeRequest as FactsRequest, factsOf, readDiffs } from "./gitlab-merge-status.js";
import { platformCall } from "./http.js";
import type { CheckRun, OwnerRule, PullReadiness, ReviewDecision } from "./readiness.js";

// GitLab in bounded calls, side by side: the merge request, its approvals,
// its approval rules (Premium: refused elsewhere, then the CODEOWNERS file
// at the base is matched instead), the project's merge settings, at most
// MAX_DISCUSSION_PAGES pages of discussions and the diffs the pre-merge
// checks count. Approvals a push resets are gone from GitLab's own answer.

const PER_PAGE = 100;
const MAX_DISCUSSION_PAGES = 5;
const MAX_RULE_OWNERS = 20;

type User = { username: string };
type MergeRequest = FactsRequest & {
  project_id: number;
  state: "opened" | "closed" | "locked" | "merged";
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  diff_refs: DiffRefs | null;
  head_pipeline?: { status: string } | null;
};
type Approvals = {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: { user: User | null }[];
};
type ApprovalState = {
  rules?: {
    rule_type: string;
    name: string;
    section?: string | null;
    approved: boolean;
    approvals_required: number;
    eligible_approvers?: User[];
    approved_by?: User[];
  }[];
};
type Project = {
  only_allow_merge_if_pipeline_succeeds?: boolean;
  allow_merge_on_skipped_pipeline?: boolean | null;
};
type Discussion = { notes: { resolvable: boolean; resolved?: boolean }[] };

/** What GitLab says while it is still working out whether the merge request can merge. */
const CHECKING = new Set(["checking", "unchecked", "preparing", "approvals_syncing"]);
const WAITING_ON_PIPELINE = new Set(["ci_must_pass", "ci_still_running"]);

function pipelineState(status: string, skippedPasses: boolean): CheckRun["state"] {
  if (status === "success") return "passed";
  if (status === "skipped") return skippedPasses ? "passed" : "failed";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

function decisionOf(a: Approvals | null): ReviewDecision | null {
  if (!a || typeof a.approvals_left !== "number") return null;
  if (a.approvals_left > 0) return "review_required";
  return (a.approvals_required ?? 0) > 0 ? "approved" : "none_required";
}

const ownerRulesOf = (state: ApprovalState | null): OwnerRule[] | null => {
  const rules = (state?.rules ?? []).filter((r) => r.rule_type === "code_owner");
  if (rules.length === 0) return null;
  return rules.map((r) => ({
    name: r.section && r.section !== "codeowners" ? `[${r.section}] ${r.name}` : r.name,
    owners: (r.eligible_approvers ?? []).slice(0, MAX_RULE_OWNERS).map((u) => u.username),
    approved: r.approved,
    approvedBy: (r.approved_by ?? []).slice(0, MAX_RULE_OWNERS).map((u) => u.username),
    required: r.approvals_required > 0,
  }));
};

export function gitlabReadiness(origin: string, files: RepoFiles): PullReadiness {
  async function unresolved(token: string, url: string) {
    let count = 0;
    for (let page = 1; page <= MAX_DISCUSSION_PAGES; page++) {
      const listed = await platformCall<Discussion[]>(
        `${url}/discussions?per_page=${PER_PAGE}&page=${page}`,
        { headers: gitlabHeaders(token) },
      );
      if (!listed) return null;
      count += listed.filter((d) => d.notes.some((n) => n.resolvable && !n.resolved)).length;
      if (listed.length < PER_PAGE) return { unresolved: count, truncated: false };
    }
    return { unresolved: count, truncated: true };
  }
  return {
    async read(token, fullName, number) {
      const url = mergeRequestUrl(origin, fullName, number);
      const init = { headers: gitlabHeaders(token) };
      const [mr, approvals, approvalState, project, threads, diffs] = await Promise.all([
        platformCall<MergeRequest>(url, init),
        platformCall<Approvals>(`${url}/approvals`, init),
        platformCall<ApprovalState>(`${url}/approval_state`, init),
        platformCall<Project>(`${origin}/api/v4/projects/${encodeURIComponent(fullName)}`, init),
        unresolved(token, url),
        readDiffs(url, init),
      ]);
      if (!mr?.diff_refs) return null;
      const ownerRules = ownerRulesOf(approvalState);
      const codeowners = ownerRules
        ? null
        : await codeownersAt(mr.project_id, mr.diff_refs.base_sha);
      const status = mr.detailed_merge_status ?? "";
      const checking = CHECKING.has(status);
      const pipelineRequired =
        project?.only_allow_merge_if_pipeline_succeeds ??
        (WAITING_ON_PIPELINE.has(status) ? true : null);
      const pipeline = mr.head_pipeline;
      return {
        state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
        head: mr.sha,
        platformRepoId: String(mr.project_id),
        draft: mr.draft ?? mr.work_in_progress ?? false,
        conflicts: mr.has_conflicts ? true : checking ? null : false,
        behind: status === "need_rebase" ? true : checking || status === "" ? null : false,
        branchRule: null,
        rulesets: null,
        otherRules: [],
        resolveThreads: null,
        mergeable: status === "mergeable" ? true : checking ? null : false,
        reviews: {
          required:
            typeof approvals?.approvals_required === "number" ? approvals.approvals_required : null,
          requiredAtLeast: 0,
          decision: decisionOf(approvals),
          dismissesStale: null,
          requiresCodeOwners: ownerRules ? ownerRules.some((r) => r.required) : null,
          approvals: (approvals?.approved_by ?? []).flatMap((a) =>
            a.user ? [{ login: a.user.username, atHead: true, teams: [] }] : [],
          ),
        },
        checks: {
          required: pipelineRequired === null ? null : pipelineRequired ? ["pipeline"] : [],
          requiredAtLeast: [],
          runs: pipeline
            ? [
                {
                  name: "pipeline",
                  state: pipelineState(
                    pipeline.status,
                    project?.allow_merge_on_skipped_pipeline === true,
                  ),
                  required: pipelineRequired,
                },
              ]
            : [],
          truncated: false,
        },
        threads,
        changed: diffs
          ? { paths: diffs.diffs.map((d) => d.new_path), truncated: diffs.more }
          : null,
        codeowners,
        ownerRules,
        facts: diffs ? factsOf(mr, diffs) : null,
      };

      async function codeownersAt(projectId: number, base: string) {
        const reads = await files.read(
          token,
          { platformRepoId: String(projectId), fullName },
          base,
          [...CODEOWNERS_PATHS.gitlab],
          MAX_CODEOWNERS_BYTES,
        );
        if (!reads) return "unreadable" as const;
        const found = reads.find((r) => r.blobId !== null);
        if (!found) return null;
        return {
          path: found.path,
          text: found.bytes ? new TextDecoder().decode(found.bytes) : null,
        };
      }
    },
  };
}

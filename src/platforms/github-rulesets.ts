import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformSend } from "./http.js";
import type { BranchRuleRead, RulesetsRead } from "./readiness.js";

// A base branch's merge requirements come from two places on GitHub: the
// classic branch protection rule and the repository's (or organization's)
// rulesets. Both are folded into one rule where the strictest wins: the
// higher approval count, any requirement either sets, every required check.

/**
 * How long a refusal of the branch rule is answered from memory: the
 * token's permissions and the plan seldom change, and every reading of a
 * pull request's readiness asks for it.
 */
const KEEP_REFUSAL = { statuses: [403, 404], ms: 10 * 60_000 } as const;

/** Rules one reading of a branch's rulesets takes; a full page may hide more. */
const MAX_BRANCH_RULES = 100;

export type GithubRule = {
  requiresApprovingReviews: boolean;
  requiredApprovingReviewCount: number | null;
  requiresCodeOwnerReviews: boolean;
  dismissesStaleReviews: boolean;
  requiresStatusChecks: boolean;
  requiredStatusCheckContexts: (string | null)[] | null;
  requiresConversationResolution?: boolean;
};

type Protection = {
  message?: string;
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
  };
  required_status_checks?: { contexts?: string[]; checks?: { context: string }[] };
  required_conversation_resolution?: { enabled?: boolean };
};

/** The branch as anyone who reads the repository sees it: protected or not, and its required checks. */
type BranchSummary = {
  protected?: boolean;
  protection?: {
    required_status_checks?: {
      enforcement_level?: string;
      contexts?: string[];
      checks?: { context: string }[];
    };
  };
};

type BranchRule = {
  type?: string;
  parameters?: {
    required_approving_review_count?: number;
    require_code_owner_review?: boolean;
    dismiss_stale_reviews_on_push?: boolean;
    required_review_thread_resolution?: boolean;
    required_status_checks?: { context?: string }[];
  };
};

/** Rule types that can hold a merge back and are not judged item by item. */
const UNJUDGED = new Set([
  "merge_queue",
  "required_deployments",
  "required_signatures",
  "required_linear_history",
  "code_scanning",
  "workflows",
  "update",
]);

const NOT_PROTECTED = /branch not protected/i;
const PLAN_WITHOUT_RULES = /upgrade to github pro|make this repository public/i;

const contextsOf = (rule: GithubRule) =>
  (rule.requiredStatusCheckContexts ?? []).flatMap((n) => (n ? [n] : []));

export function strictest(a: GithubRule | null, b: GithubRule | null): GithubRule | null {
  if (!a || !b) return a ?? b;
  return {
    requiresApprovingReviews: a.requiresApprovingReviews || b.requiresApprovingReviews,
    requiredApprovingReviewCount: Math.max(
      a.requiredApprovingReviewCount ?? 0,
      b.requiredApprovingReviewCount ?? 0,
    ),
    requiresCodeOwnerReviews: a.requiresCodeOwnerReviews || b.requiresCodeOwnerReviews,
    dismissesStaleReviews: a.dismissesStaleReviews || b.dismissesStaleReviews,
    requiresStatusChecks: a.requiresStatusChecks || b.requiresStatusChecks,
    requiredStatusCheckContexts: [...new Set([...contextsOf(a), ...contextsOf(b)])],
    requiresConversationResolution:
      a.requiresConversationResolution === true || b.requiresConversationResolution === true,
  };
}

const NO_RULE: GithubRule = {
  requiresApprovingReviews: false,
  requiredApprovingReviewCount: 0,
  requiresCodeOwnerReviews: false,
  dismissesStaleReviews: false,
  requiresStatusChecks: false,
  requiredStatusCheckContexts: [],
  requiresConversationResolution: false,
};

function ruleOfBranchRule(r: BranchRule): GithubRule | null {
  const p = r.parameters ?? {};
  if (r.type === "pull_request") {
    return {
      ...NO_RULE,
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: p.required_approving_review_count ?? 0,
      requiresCodeOwnerReviews: p.require_code_owner_review === true,
      dismissesStaleReviews: p.dismiss_stale_reviews_on_push === true,
      requiresConversationResolution: p.required_review_thread_resolution === true,
    };
  }
  if (r.type === "required_status_checks") {
    return {
      ...NO_RULE,
      requiresStatusChecks: true,
      requiredStatusCheckContexts: (p.required_status_checks ?? []).flatMap((c) =>
        c.context ? [c.context] : [],
      ),
    };
  }
  return null;
}

function ruleOfProtection(p: Protection): GithubRule {
  const reviews = p.required_pull_request_reviews;
  const checks = p.required_status_checks;
  return {
    requiresApprovingReviews: reviews !== undefined,
    requiredApprovingReviewCount: reviews?.required_approving_review_count ?? 0,
    requiresCodeOwnerReviews: reviews?.require_code_owner_reviews === true,
    dismissesStaleReviews: reviews?.dismiss_stale_reviews === true,
    requiresStatusChecks: checks !== undefined,
    requiredStatusCheckContexts: [
      ...new Set([...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c) => c.context)]),
    ],
    requiresConversationResolution: p.required_conversation_resolution?.enabled === true,
  };
}

export async function protectionOf(
  host: GithubHost,
  token: string,
  fullName: string,
  branch: string,
): Promise<{ read: BranchRuleRead; rule: GithubRule | null }> {
  const sent = await platformSend<Protection>(
    `${host.api}/repos/${githubRepoPath(fullName)}/branches/${githubRepoPath(branch)}/protection`,
    { headers: githubHeaders(token) },
    { remember: KEEP_REFUSAL },
  );
  if (sent?.status === 200 && sent.body) return { read: "read", rule: ruleOfProtection(sent.body) };
  const message = sent?.body?.message ?? "";
  if (sent?.status === 404 && NOT_PROTECTED.test(message)) return { read: "none", rule: null };
  if (sent?.status === 403 && PLAN_WITHOUT_RULES.test(message)) {
    return { read: "unavailable", rule: null };
  }
  return summaryOf(host, token, fullName, branch);
}

/**
 * The full rule needs Administration read and an admin, so a user token
 * of the App is often refused it. The branch itself, which Contents read
 * answers, still says whether it is protected and which checks it requires:
 * those are a floor, and the rest of the rule stays not known.
 */
async function summaryOf(
  host: GithubHost,
  token: string,
  fullName: string,
  branch: string,
): Promise<{ read: BranchRuleRead; rule: GithubRule | null }> {
  const sent = await platformSend<BranchSummary>(
    `${host.api}/repos/${githubRepoPath(fullName)}/branches/${githubRepoPath(branch)}`,
    { headers: githubHeaders(token) },
  );
  const summary = sent?.status === 200 ? sent.body : null;
  if (summary?.protected === false) return { read: "none", rule: null };
  const checks = summary?.protection?.required_status_checks;
  if (!checks || (checks.enforcement_level ?? "off") === "off") {
    return { read: "unreadable", rule: null };
  }
  return {
    read: "unreadable",
    rule: {
      ...NO_RULE,
      requiresStatusChecks: true,
      requiredStatusCheckContexts: [
        ...new Set([...(checks.contexts ?? []), ...(checks.checks ?? []).map((c) => c.context)]),
      ],
    },
  };
}

/** The active ruleset rules on a branch, in one page; any refusal reads as unreadable. */
export async function rulesetsOf(
  host: GithubHost,
  token: string,
  fullName: string,
  branch: string,
): Promise<{ read: RulesetsRead; rule: GithubRule | null; unjudged: string[] }> {
  const sent = await platformSend<BranchRule[]>(
    `${host.api}/repos/${githubRepoPath(fullName)}/rules/branches/${githubRepoPath(branch)}?per_page=${MAX_BRANCH_RULES}`,
    { headers: githubHeaders(token) },
  );
  if (sent?.status !== 200 || !Array.isArray(sent.body)) {
    return { read: "unreadable", rule: null, unjudged: [] };
  }
  const rules = sent.body;
  return {
    read: rules.length >= MAX_BRANCH_RULES ? "partial" : "read",
    rule: rules.reduce<GithubRule | null>((acc, r) => strictest(acc, ruleOfBranchRule(r)), null),
    unjudged: [...new Set(rules.flatMap((r) => (r.type && UNJUDGED.has(r.type) ? [r.type] : [])))],
  };
}

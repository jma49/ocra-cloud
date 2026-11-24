import { CODEOWNERS_PATHS, MAX_CODEOWNERS_BYTES } from "../codeowners.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { type GithubRule, protectionOf, rulesetsOf, strictest } from "./github-rulesets.js";
import {
  type Approval,
  type CheckRun,
  MAX_READINESS_CHECKS,
  MAX_READINESS_FILES,
  MAX_READINESS_THREADS,
  type PullReadiness,
  type ReviewDecision,
} from "./readiness.js";

// One GraphQL query reads it all. Fields a token may be refused (the branch
// rule needs Administration read, a review's teams Members read) are asked
// for where a refusal empties only themselves: the branch rule is nullable,
// and the reviews' teams are a second listing of the same reviews. A null
// rule says neither "none" nor "refused", so the REST rule is asked once:
// its answer tells an unprotected branch from a refusal and from a plan
// without branch protection. The branch's rulesets are one more REST call,
// folded in where the strictest wins; while either is not fully read, what
// the read part requires is a floor, not the answer.

const OWNER_FILES = CODEOWNERS_PATHS.github;

type Blob = { byteSize: number; isBinary: boolean | null; text: string | null } | null;
export type Context =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      isRequired: boolean;
    }
  | { __typename: "StatusContext"; context: string; state: string; isRequired: boolean }
  | null;
type Pull = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Absent from an answer that predates it. */
  mergeStateStatus?: string;
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | null;
  title: string;
  body: string | null;
  headRefOid: string;
  baseRefName: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  baseRef: {
    branchProtectionRule: GithubRule | null;
    target: Record<string, { object: Blob } | null> | null;
  } | null;
  reviews: {
    nodes: ({
      state: string;
      author: { login: string } | null;
      commit: { oid: string } | null;
    } | null)[];
  };
  teams: {
    nodes: ({
      author: { login: string } | null;
      onBehalfOf: { nodes: ({ combinedSlug: string } | null)[] };
    } | null)[];
  } | null;
  reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: ({ isResolved: boolean } | null)[] };
  files: { pageInfo: { hasNextPage: boolean }; nodes: ({ path: string } | null)[] } | null;
  commits: {
    nodes: ({
      commit: {
        statusCheckRollup: {
          contexts: { pageInfo: { hasNextPage: boolean }; nodes: Context[] };
        } | null;
      };
    } | null)[];
  };
};
type Answer = {
  data?: { repository: { databaseId: number; pullRequest: Pull | null } | null } | null;
  errors?: { path?: (string | number)[] }[];
};

const blobFields = OWNER_FILES.map(
  (path, i) =>
    `c${i}: file(path: ${JSON.stringify(path)}) { object { ... on Blob { byteSize isBinary text } } }`,
).join("\n            ");

const READINESS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      state isDraft mergeable mergeStateStatus reviewDecision
      title body headRefOid baseRefName changedFiles additions deletions
      baseRef {
        branchProtectionRule {
          requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews
          dismissesStaleReviews requiresStatusChecks requiredStatusCheckContexts
          requiresConversationResolution
        }
        target {
          ... on Commit {
            ${blobFields}
          }
        }
      }
      reviews: latestOpinionatedReviews(first: 100, writersOnly: true) {
        nodes { state author { login } commit { oid } }
      }
      teams: latestOpinionatedReviews(first: 100, writersOnly: true) {
        nodes { author { login } onBehalfOf(first: 10) { nodes { combinedSlug } } }
      }
      reviewThreads(first: ${MAX_READINESS_THREADS}) { pageInfo { hasNextPage } nodes { isResolved } }
      files(first: ${MAX_READINESS_FILES}) { pageInfo { hasNextPage } nodes { path } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: ${MAX_READINESS_CHECKS}) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
                  ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const DECISION = {
  APPROVED: "approved",
  REVIEW_REQUIRED: "review_required",
  CHANGES_REQUESTED: "changes_requested",
} as const satisfies Record<NonNullable<Pull["reviewDecision"]>, ReviewDecision>;

const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function runOf(node: NonNullable<Context>): CheckRun {
  if (node.__typename === "CheckRun") {
    const state =
      node.status !== "COMPLETED"
        ? "pending"
        : PASSED_CONCLUSIONS.has(node.conclusion ?? "")
          ? "passed"
          : "failed";
    return { name: node.name, state, required: node.isRequired };
  }
  const state =
    node.state === "SUCCESS"
      ? "passed"
      : node.state === "PENDING" || node.state === "EXPECTED"
        ? "pending"
        : "failed";
  return { name: node.context, state, required: node.isRequired };
}

function codeownersOf(target: Record<string, { object: Blob } | null> | null | undefined) {
  if (!target) return "unreadable" as const;
  for (const [i, path] of OWNER_FILES.entries()) {
    const blob = target[`c${i}`]?.object;
    if (!blob) continue;
    const readable = !blob.isBinary && blob.byteSize <= MAX_CODEOWNERS_BYTES;
    return { path, text: readable ? blob.text : null };
  }
  return null;
}

export function githubReadiness(host: GithubHost, post: GithubGraphql): PullReadiness {
  return {
    async read(token, fullName, number) {
      const [owner, name] = fullName.split("/");
      const answer = await post(token)<Answer>({
        query: READINESS,
        variables: { owner, name, number },
      });
      const repo = answer?.data?.repository;
      const pull = repo?.pullRequest;
      if (!repo || !pull) return null;
      const refused = (field: string) =>
        (answer?.errors ?? []).some((e) => e.path?.includes(field));
      const head = pull.headRefOid;
      const graphRule = refused("branchProtectionRule")
        ? null
        : (pull.baseRef?.branchProtectionRule ?? null);
      const [classic, rulesets] = await Promise.all([
        graphRule
          ? { read: "read" as const, rule: graphRule }
          : pull.baseRef
            ? protectionOf(host, token, fullName, pull.baseRefName)
            : { read: "unreadable" as const, rule: null },
        rulesetsOf(host, token, fullName, pull.baseRefName),
      ]);
      const branchRule = classic.read;
      const merged = strictest(classic.rule, rulesets.rule);
      const ruleRead =
        (branchRule === "read" || branchRule === "none") && rulesets.read !== "partial";
      const rule = ruleRead ? merged : null;
      const floor = ruleRead ? null : merged;
      const decision = pull.reviewDecision ? DECISION[pull.reviewDecision] : null;
      const teamsRead = pull.teams !== null && !refused("onBehalfOf");
      const teamsOf = new Map(
        (pull.teams?.nodes ?? []).flatMap((n) =>
          n?.author
            ? [[n.author.login, n.onBehalfOf.nodes.flatMap((t) => (t ? [t.combinedSlug] : []))]]
            : [],
        ),
      );
      const approvals: Approval[] = pull.reviews.nodes.flatMap((n) =>
        n?.state === "APPROVED" && n.author
          ? [
              {
                login: n.author.login,
                atHead: n.commit?.oid === head,
                teams: teamsRead ? (teamsOf.get(n.author.login) ?? []) : [],
              },
            ]
          : [],
      );
      const contexts = pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
      const contextNodes = contexts?.nodes ?? [];
      const files = pull.files;
      return {
        state: pull.state === "OPEN" ? "open" : pull.state === "MERGED" ? "merged" : "closed",
        head,
        platformRepoId: String(repo.databaseId),
        draft: pull.isDraft,
        conflicts: pull.mergeable === "UNKNOWN" ? null : pull.mergeable === "CONFLICTING",
        behind:
          !pull.mergeStateStatus || pull.mergeStateStatus === "UNKNOWN"
            ? null
            : pull.mergeStateStatus === "BEHIND",
        branchRule,
        rulesets: rulesets.read,
        otherRules: rulesets.unjudged,
        resolveThreads: rule
          ? rule.requiresConversationResolution === true
          : floor?.requiresConversationResolution
            ? true
            : null,
        mergeable: null,
        reviews: {
          required: rule
            ? rule.requiresApprovingReviews
              ? (rule.requiredApprovingReviewCount ?? 0)
              : 0
            : ruleRead && decision === null
              ? 0
              : null,
          requiredAtLeast: floor?.requiresApprovingReviews
            ? (floor.requiredApprovingReviewCount ?? 0)
            : 0,
          decision: decision ?? (ruleRead && !rule ? "none_required" : null),
          dismissesStale: rule
            ? rule.dismissesStaleReviews
            : ruleRead
              ? false
              : floor?.dismissesStaleReviews
                ? true
                : null,
          requiresCodeOwners: rule
            ? rule.requiresCodeOwnerReviews
            : ruleRead
              ? false
              : floor?.requiresCodeOwnerReviews
                ? true
                : null,
          approvals,
        },
        checks: refused("statusCheckRollup")
          ? null
          : {
              required: rule
                ? rule.requiresStatusChecks
                  ? (rule.requiredStatusCheckContexts ?? []).flatMap((n) => (n ? [n] : []))
                  : []
                : ruleRead
                  ? []
                  : null,
              requiredAtLeast: (floor?.requiredStatusCheckContexts ?? []).flatMap((n) =>
                n ? [n] : [],
              ),
              runs: contextNodes.flatMap((n) => (n ? [runOf(n)] : [])),
              truncated:
                (contexts?.pageInfo.hasNextPage ?? false) || contextNodes.some((n) => n === null),
            },
        threads: {
          unresolved: pull.reviewThreads.nodes.filter((t) => t && !t.isResolved).length,
          truncated: pull.reviewThreads.pageInfo.hasNextPage,
        },
        changed: files
          ? {
              paths: files.nodes.flatMap((f) => (f ? [f.path] : [])),
              truncated: files.pageInfo.hasNextPage,
            }
          : null,
        codeowners: codeownersOf(pull.baseRef?.target),
        ownerRules: null,
        facts: {
          title: pull.title,
          description: pull.body ?? "",
          head,
          files: pull.changedFiles,
          lines: pull.additions + pull.deletions,
          exact: true,
        },
      };
    },
  };
}

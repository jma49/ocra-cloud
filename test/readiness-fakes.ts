import { expect } from "vitest";
import type { PullReadinessView, ReadinessItem } from "../src/shared/index.js";
import { githubFake } from "./platform-fakes.js";

// GitHub's answers to a merge readiness reading: the one GraphQL query, and
// the REST branch rule it is followed by when the query gives none, and the
// rulesets on the base branch, read alongside.

export const HEAD = "c".repeat(40);
export const OLD = "d".repeat(40);
export const BASE = "b".repeat(40);
const CODEOWNERS = [
  "/src/      @lead",
  "/src/db/   @dba",
  "/web/      @octo/web",
  "*.md docs@example.com",
].join("\n");

type Review = { login: string; oid: string; teams?: string[] };
export type GithubPull = {
  rule?: Record<string, unknown> | null;
  ruleRefused?: boolean;
  /** GitHub's REST answer for the branch rule, asked when GraphQL gives none. */
  protection?: { status: number; body: Record<string, unknown> };
  /** GitHub's REST answer for the rules on the base branch; none by default. */
  rulesets?: { status: number; body: unknown };
  decision?: string | null;
  draft?: boolean;
  mergeable?: string;
  reviews?: Review[];
  files?: string[];
  threads?: boolean[];
  contexts?: Record<string, unknown>[];
  state?: string;
  title?: string;
};

export const REFUSED = { status: 403, body: { message: "Resource not accessible by integration" } };
export const NOT_PROTECTED = { status: 404, body: { message: "Branch not protected" } };
export const PLAN = {
  status: 403,
  body: { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
};

export const PROTECTION = "GET https://api.github.com/repos/octo/api/branches/main/protection";
const RULESETS = "https://api.github.com/repos/octo/api/rules/branches/main?per_page=100";
export const RULESETS_CALL = `GET ${RULESETS}`;

/** A ruleset rule as GitHub lists it for a branch. */
export const ruleOf = (type: string, parameters: Record<string, unknown> = {}) => ({
  type,
  ruleset_source_type: "Repository",
  ruleset_source: "octo/api",
  ruleset_id: 1,
  parameters,
});

const RULE = {
  requiresApprovingReviews: true,
  requiredApprovingReviewCount: 2,
  requiresCodeOwnerReviews: true,
  dismissesStaleReviews: true,
  requiresStatusChecks: true,
  requiredStatusCheckContexts: ["ci", "lint"],
};

export function githubPull(p: GithubPull = {}) {
  const calls: string[] = [];
  githubFake({
    extra: async (req) => {
      if (!req.url.startsWith("https://api.github.com/") || req.url.includes("/installations")) {
        return undefined;
      }
      if (req.url === "https://api.github.com/user") return undefined;
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "https://api.github.com/repos/octo/api/branches/main/protection") {
        const answer = p.protection ?? REFUSED;
        return Response.json(answer.body, { status: answer.status });
      }
      if (req.url === RULESETS) {
        const answer = p.rulesets ?? { status: 200, body: [] };
        return Response.json(answer.body, { status: answer.status });
      }
      if (req.method !== "POST" || !req.url.endsWith("/graphql")) return undefined;
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      expect(body.variables).toEqual({ owner: "octo", name: "api", number: 7 });
      const reviews = p.reviews ?? [];
      return Response.json({
        data: {
          repository: {
            databaseId: 1,
            pullRequest: {
              state: p.state ?? "OPEN",
              isDraft: p.draft ?? false,
              mergeable: p.mergeable ?? "MERGEABLE",
              reviewDecision: p.decision === undefined ? "REVIEW_REQUIRED" : p.decision,
              title: p.title ?? "fix: cap refunds",
              body: "",
              headRefOid: HEAD,
              baseRefName: "main",
              changedFiles: (p.files ?? []).length,
              additions: 3,
              deletions: 1,
              baseRef: {
                branchProtectionRule: p.ruleRefused ? null : p.rule === undefined ? RULE : p.rule,
                target: {
                  c0: null,
                  c1: {
                    object: {
                      byteSize: CODEOWNERS.length,
                      isBinary: false,
                      text: CODEOWNERS,
                    },
                  },
                  c2: null,
                },
              },
              reviews: {
                nodes: reviews.map((r) => ({
                  state: "APPROVED",
                  author: { login: r.login },
                  commit: { oid: r.oid },
                })),
              },
              teams: {
                nodes: reviews.map((r) => ({
                  author: { login: r.login },
                  onBehalfOf: { nodes: (r.teams ?? []).map((combinedSlug) => ({ combinedSlug })) },
                })),
              },
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: (p.threads ?? []).map((isResolved) => ({ isResolved })),
              },
              files: {
                pageInfo: { hasNextPage: false },
                nodes: (p.files ?? []).map((path) => ({ path })),
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: { pageInfo: { hasNextPage: false }, nodes: p.contexts ?? [] },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        ...(p.ruleRefused
          ? {
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["repository", "pullRequest", "baseRef", "branchProtectionRule"],
                },
              ],
            }
          : {}),
      });
    },
  });
  return calls;
}

export const run = (
  name: string,
  status: string,
  conclusion: string | null,
  isRequired: boolean,
) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  isRequired,
});

export async function readiness(send: (p: string) => Promise<Response>, query: string) {
  const res = await send(`/api/pulls/readiness?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PullReadinessView;
}

export const byKind = (view: PullReadinessView) =>
  Object.fromEntries(view.items.map((i) => [i.kind, [i.state, i.detail]])) as Record<
    ReadinessItem["kind"],
    [ReadinessItem["state"], string]
  >;

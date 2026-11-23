import { outcomeOf } from "./actions.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { CHECKS, REVIEW } from "./github-pulls.js";
import { platformCall, platformSend } from "./http.js";
import {
  type BranchPair,
  type LayerStanding,
  MAX_OPEN_PAGES,
  type OpenPull,
  type PullStacks,
} from "./stacks.js";

const PER_PAGE = 100;

const ROLLUP = "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

const query = (
  checks: boolean,
) => `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft headRefName baseRefName headRefOid isCrossRepository reviewDecision
        ${checks ? ROLLUP : ""}
      }
    }
  }
}`;

const STANDING = (checks: boolean) => `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state headRefOid headRefName baseRefName mergeStateStatus
      ${checks ? ROLLUP : ""}
    }
  }
}`;

/** One query for every pair: the head branch as the comparison's base says what it lacks of the other. */
const behindQuery = (pairs: readonly BranchPair[]) => {
  const names = pairs.map((_, i) => `$h${i}: String!, $b${i}: String!`).join(", ");
  const refs = pairs.map(
    (_, i) => `p${i}: ref(qualifiedName: $h${i}) { compare(headRef: $b${i}) { aheadBy } }`,
  );
  return `query($owner: String!, $name: String!, ${names}) {
  repository(owner: $owner, name: $name) { ${refs.join(" ")} }
}`;
};
type BehindAnswer = {
  data?: { repository: Record<string, { compare: { aheadBy: number } | null } | null> | null };
};

type Rollup = {
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Node = Rollup & {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  reviewDecision: string | null;
};
type Page = {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: (Node | null)[];
};
type Answer = { data?: { repository: { pullRequests: Page } | null }; errors?: unknown[] };
type Layer = Rollup & {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeStateStatus: string;
};
type LayerAnswer = {
  data?: { repository: { pullRequest: Layer | null } | null };
  errors?: unknown[];
};
type RestPull = {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  head: { ref: string; sha: string; repo: { id: number } | null };
  base: { ref: string; repo: { id: number } };
};

const rollupOf = (n: Rollup) => n.commits?.nodes[0]?.commit.statusCheckRollup?.state;

const openPull = (n: Node): OpenPull => {
  const rollup = rollupOf(n);
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    draft: n.isDraft,
    head: n.headRefName,
    base: n.baseRefName,
    headSha: n.headRefOid,
    checks: (rollup && CHECKS[rollup]) || null,
    review: (n.reviewDecision && REVIEW[n.reviewDecision]) || null,
  };
};

/** UNSTABLE is a failing check that is not required: GitHub merges it. */
const MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

function blockerOf(layer: Layer): LayerStanding["blocker"] {
  if (MERGEABLE.has(layer.mergeStateStatus)) return null;
  if (layer.mergeStateStatus === "BEHIND") return "behind";
  if (layer.mergeStateStatus === "DIRTY") return "conflicts";
  const checks = CHECKS[rollupOf(layer) ?? ""];
  if (checks === "failing") return "checks_failed";
  if (checks === "pending") return "checks_pending";
  return "waiting";
}

export function githubStacks(host: GithubHost, post: GithubGraphql): PullStacks {
  /** Asked with the head's checks first: without the App's checks permission GitHub nulls the node. */
  async function withChecks<T extends { errors?: unknown[] }>(
    ask: (checks: boolean) => Promise<T | null>,
    lost: (answer: T) => boolean,
  ) {
    const answer = await ask(true);
    return answer?.errors && lost(answer) ? ask(false) : answer;
  }
  return {
    async open(token, fullName) {
      const [owner, name] = fullName.split("/");
      const pulls: OpenPull[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_OPEN_PAGES; page++) {
        const answer: Answer | null = await withChecks(
          (checks) =>
            post(token)<Answer>({
              query: query(checks),
              variables: { owner, name, first: PER_PAGE, after },
            }),
          (a) => !!a.data?.repository?.pullRequests.nodes.some((n) => n === null),
        );
        const listed: Page | undefined = answer?.data?.repository?.pullRequests;
        if (!listed) return page === 0 ? null : pulls;
        // A fork's branch of the same name is not this repository's branch.
        for (const n of listed.nodes) if (n && !n.isCrossRepository) pulls.push(openPull(n));
        if (!listed.pageInfo?.hasNextPage || !listed.pageInfo.endCursor) break;
        after = listed.pageInfo.endCursor;
      }
      return pulls;
    },
    async children(token, fullName, branch) {
      const params = new URLSearchParams({ state: "open", base: branch, per_page: "100" });
      const listed = await platformCall<RestPull[]>(
        `${host.api}/repos/${githubRepoPath(fullName)}/pulls?${params}`,
        { headers: githubHeaders(token) },
      );
      if (!listed) return null;
      return listed
        .filter((p) => p.head.repo?.id === p.base.repo.id)
        .map((p) => ({
          number: p.number,
          title: p.title,
          url: p.html_url,
          draft: p.draft === true,
          head: p.head.ref,
          base: p.base.ref,
          headSha: p.head.sha,
          checks: null,
          review: null,
        }));
    },
    async standing(token, fullName, number) {
      const [owner, name] = fullName.split("/");
      const answer = await withChecks(
        (checks) =>
          post(token)<LayerAnswer>({ query: STANDING(checks), variables: { owner, name, number } }),
        (a) => !a.data?.repository?.pullRequest,
      );
      const layer = answer?.data?.repository?.pullRequest;
      if (!layer) return null;
      return {
        state: layer.state === "OPEN" ? "open" : layer.state === "MERGED" ? "merged" : "closed",
        head: layer.headRefOid,
        headBranch: layer.headRefName,
        base: layer.baseRefName,
        blocker: blockerOf(layer),
      };
    },
    async behind(token, fullName, pairs) {
      if (pairs.length === 0) return [];
      const [owner, name] = fullName.split("/");
      const branches = Object.fromEntries(
        pairs.flatMap((p, i) => [
          [`h${i}`, `refs/heads/${p.head}`],
          [`b${i}`, `refs/heads/${p.base}`],
        ]),
      );
      const answer = await post(token)<BehindAnswer>({
        query: behindQuery(pairs),
        variables: { owner, name, ...branches },
      });
      const refs = answer?.data?.repository;
      return pairs.map((_, i) => refs?.[`p${i}`]?.compare?.aheadBy ?? null);
    },
    async retarget(token, fullName, number, base) {
      return outcomeOf(
        await platformSend(`${host.api}/repos/${githubRepoPath(fullName)}/pulls/${number}`, {
          method: "PATCH",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ base }),
        }),
      );
    },
  };
}

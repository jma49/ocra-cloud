import { outcomeOf } from "./actions.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { CHECKS, REVIEW } from "./github-pulls.js";
import { platformSend } from "./http.js";
import type { OpenPull, PullStacks } from "./stacks.js";

const API = "https://api.github.com";
const PER_PAGE = 100;

const query = (checks: boolean) => `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName baseRefName headRefOid isCrossRepository reviewDecision
        ${checks ? "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }" : ""}
      }
    }
  }
}`;

type Node = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  reviewDecision: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Answer = {
  data?: { repository: { pullRequests: { nodes: (Node | null)[] } } | null };
  errors?: unknown[];
};

const openPull = (n: Node): OpenPull => {
  const rollup = n.commits?.nodes[0]?.commit.statusCheckRollup?.state;
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

export function githubStacks(
  post: (token: string) => <T>(path: string, body: unknown) => Promise<T | null>,
): PullStacks {
  return {
    async open(token, fullName) {
      const [owner, name] = fullName.split("/");
      const ask = (checks: boolean) =>
        post(token)<Answer>("/graphql", {
          query: query(checks),
          variables: { owner, name, first: PER_PAGE },
        });
      let answer = await ask(true);
      // Without the App's checks permission GitHub nulls the whole pull.
      const lost = answer?.data?.repository?.pullRequests.nodes.some((n) => n === null);
      if (answer?.errors && lost) answer = await ask(false);
      const nodes = answer?.data?.repository?.pullRequests.nodes;
      if (!nodes) return null;
      // A fork's branch of the same name is not this repository's branch.
      return nodes.filter((n): n is Node => n !== null && !n.isCrossRepository).map(openPull);
    },
    async retarget(token, fullName, number, base) {
      return outcomeOf(
        await platformSend(`${API}/repos/${githubRepoPath(fullName)}/pulls/${number}`, {
          method: "PATCH",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ base }),
        }),
      );
    },
  };
}

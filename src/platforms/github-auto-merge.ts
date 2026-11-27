import type { MergeMethod } from "../shared/index.js";
import type { PullAutoMerge } from "./auto-merge.js";
import type { GithubHost } from "./github-host.js";
import { githubMergeGraphql } from "./github-merge-graphql.js";

// GitHub's auto-merge (a repository setting, "Allow auto-merge") through
// GraphQL. It waits on the branch's required checks and reviews only: the
// ocra pre-merge check counts where branch protection requires it.

const METHOD = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
} as const satisfies Record<MergeMethod, string>;

type MergeState =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

/** Mergeable now: UNSTABLE is a failing check that is not required. */
const MERGEABLE = new Set<MergeState>(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

type Pull = {
  id: string;
  headRefOid: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeStateStatus: MergeState;
  autoMergeRequest: { mergeMethod: string } | null;
};
type Read = { repository: { autoMergeAllowed: boolean; pullRequest: Pull | null } | null };

const PULL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    autoMergeAllowed
    pullRequest(number: $number) {
      id headRefOid state mergeStateStatus autoMergeRequest { mergeMethod }
    }
  }
}`;
const ENABLE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { clientMutationId }
}`;
const DISABLE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
}`;

export function githubAutoMerge(host: GithubHost): PullAutoMerge {
  const graphql = githubMergeGraphql(host);
  const read = async (token: string, fullName: string, number: number) => {
    const [owner, name] = fullName.split("/");
    const sent = await graphql.request<Read>(token, PULL, { owner, name, number });
    if (sent?.status !== 200) return null;
    const repo = sent.body?.data?.repository;
    const pull = repo?.pullRequest;
    return repo && pull ? { allowed: repo.autoMergeAllowed, pull } : null;
  };
  return {
    async enable(token, fullName, number, merge) {
      const r = await read(token, fullName, number);
      if (!r) return null;
      if (r.pull.state !== "OPEN") return "refused";
      if (r.pull.headRefOid !== merge.head) return "head_moved";
      if (!r.allowed) return "unavailable";
      // GitHub refuses to arm a pull request it would merge now.
      if (MERGEABLE.has(r.pull.mergeStateStatus)) return "ready";
      return graphql.mutate(token, ENABLE, {
        id: r.pull.id,
        method: METHOD[merge.method],
        head: merge.head,
      });
    },
    async disable(token, fullName, number) {
      const r = await read(token, fullName, number);
      if (!r) return null;
      if (!r.pull.autoMergeRequest) return "done";
      return graphql.mutate(token, DISABLE, { id: r.pull.id });
    },
    async readiness(token, fullName, number) {
      const r = await read(token, fullName, number);
      if (!r) return null;
      const state =
        r.pull.state === "OPEN" ? "open" : r.pull.state === "MERGED" ? "merged" : "closed";
      return {
        state,
        head: r.pull.headRefOid,
        mergeable: MERGEABLE.has(r.pull.mergeStateStatus),
      };
    },
  };
}

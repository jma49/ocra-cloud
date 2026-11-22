import type { MergeMethod, PullActionOutcome } from "../shared/index.js";
import type { PullAutoMerge } from "./auto-merge.js";
import { githubHeaders } from "./github-changes.js";
import { platformSend } from "./http.js";

// GitHub's auto-merge (a repository setting, "Allow auto-merge") through
// GraphQL. It waits on the branch's required checks and reviews only: the
// ocra pre-merge check counts where branch protection requires it.

const GRAPHQL = "https://api.github.com/graphql";

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
type Answer<T> = { data?: T | null; errors?: { type?: string }[] };
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

function outcomeOfMutation(sent: { status: number; body: Answer<unknown> | null } | null) {
  if (!sent || sent.status >= 500) return null;
  const errors = sent.body?.errors ?? [];
  if (sent.status >= 400 || errors.some((e) => e.type === "FORBIDDEN")) return "refused";
  return errors.length > 0 ? "not_mergeable" : "done";
}

export function githubAutoMerge(): PullAutoMerge {
  const ask = <T>(token: string, query: string, variables: Record<string, unknown>) =>
    platformSend<Answer<T>>(GRAPHQL, {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  const read = async (token: string, fullName: string, number: number) => {
    const [owner, name] = fullName.split("/");
    const sent = await ask<Read>(token, PULL, { owner, name, number });
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
      return outcomeOfMutation(
        await ask(token, ENABLE, { id: r.pull.id, method: METHOD[merge.method], head: merge.head }),
      );
    },
    async disable(token, fullName, number): Promise<PullActionOutcome | null> {
      const r = await read(token, fullName, number);
      if (!r) return null;
      if (!r.pull.autoMergeRequest) return "done";
      return outcomeOfMutation(await ask(token, DISABLE, { id: r.pull.id }));
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

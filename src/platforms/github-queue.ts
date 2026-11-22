import type { PullActionOutcome, QueueState } from "../shared/index.js";
import { githubHeaders } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformSend } from "./http.js";
import type { MergeQueue } from "./queue.js";

type EntryState = "QUEUED" | "AWAITING_CHECKS" | "MERGEABLE" | "LOCKED" | "UNMERGEABLE";

const STATE = {
  QUEUED: "waiting",
  AWAITING_CHECKS: "checking",
  MERGEABLE: "ready",
  LOCKED: "merging",
  UNMERGEABLE: "blocked",
} as const satisfies Record<EntryState, QueueState>;

type Pull = {
  id: string;
  headRefOid: string;
  mergeQueue: { id: string } | null;
  mergeQueueEntry: { state: EntryState; position: number } | null;
};
type Answer<T> = { data?: T | null; errors?: { type?: string }[] };

const PULL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid mergeQueue { id } mergeQueueEntry { state position }
    }
  }
}`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { clientMutationId }
}`;
const DEQUEUE = `mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { clientMutationId }
}`;

/** A mutation's answer: GraphQL refuses with 200 and errors, a lack of permission as FORBIDDEN. */
function outcomeOfMutation(sent: { status: number; body: Answer<unknown> | null } | null) {
  if (!sent || sent.status >= 500) return null;
  const errors = sent.body?.errors ?? [];
  if (sent.status >= 400 || errors.some((e) => e.type === "FORBIDDEN")) return "refused";
  return errors.length > 0 ? "not_mergeable" : "done";
}

export function githubQueue(host: GithubHost): MergeQueue {
  const ask = <T>(token: string, query: string, variables: Record<string, unknown>) =>
    platformSend<Answer<T>>(host.graphql, {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  const pull = async (token: string, fullName: string, number: number) => {
    const [owner, name] = fullName.split("/");
    const sent = await ask<{ repository: { pullRequest: Pull | null } | null }>(token, PULL, {
      owner,
      name,
      number,
    });
    if (sent?.status !== 200) return null;
    return sent.body?.data?.repository?.pullRequest ?? null;
  };
  return {
    async status(token, fullName, number) {
      const p = await pull(token, fullName, number);
      if (!p) return null;
      const entry = p.mergeQueueEntry;
      return {
        enabled: p.mergeQueue !== null,
        entry: entry ? { state: STATE[entry.state], position: entry.position } : null,
      };
    },
    async enqueue(token, fullName, number, head): Promise<PullActionOutcome | null> {
      const p = await pull(token, fullName, number);
      if (!p) return null;
      if (p.headRefOid !== head) return "head_moved";
      if (!p.mergeQueue) return "refused";
      return outcomeOfMutation(await ask(token, ENQUEUE, { id: p.id, head }));
    },
    async dequeue(token, fullName, number): Promise<PullActionOutcome | null> {
      const p = await pull(token, fullName, number);
      if (!p) return null;
      if (!p.mergeQueueEntry) return "done";
      return outcomeOfMutation(await ask(token, DEQUEUE, { id: p.id }));
    },
  };
}

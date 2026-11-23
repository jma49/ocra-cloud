import {
  MAX_QUEUE_AHEAD,
  type MergeQueueView,
  type PullActionOutcome,
  type QueueState,
} from "../shared/index.js";
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

/** GitHub's word for a queue entry's state as ours; none for a word it has added since. */
export const queueStateOf = (state: string): QueueState | undefined =>
  (STATE as Record<string, QueueState>)[state];

type Pull = {
  id: string;
  headRefOid: string;
  mergeQueue: { id: string } | null;
  mergeQueueEntry: { state: EntryState; position: number } | null;
};
type Removal = {
  __typename: string;
  createdAt?: string;
  reason?: string | null;
  actor?: { login: string } | null;
};
type Standing = {
  mergeQueue: {
    entries: {
      totalCount: number;
      nodes: ({
        state: EntryState;
        position: number;
        pullRequest: { number: number; title: string } | null;
      } | null)[];
    };
  } | null;
  mergeQueueEntry: {
    state: EntryState;
    position: number;
    enqueuedAt: string;
    estimatedTimeToMerge: number | null;
    enqueuer: { login: string } | null;
  } | null;
  timelineItems: { nodes: (Removal | null)[] };
};
type Answer<T> = { data?: T | null; errors?: { type?: string }[] };
type InRepository<T> = { repository: { pullRequest: T | null } | null };

const PULL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid mergeQueue { id } mergeQueueEntry { state position }
    }
  }
}`;
/** The queue around the pull request, and the newest of its joining or leaving it. */
const STANDING = `query($owner: String!, $name: String!, $number: Int!, $ahead: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      mergeQueue {
        entries(first: $ahead) {
          totalCount
          nodes { state position pullRequest { number title } }
        }
      }
      mergeQueueEntry { state position enqueuedAt estimatedTimeToMerge enqueuer { login } }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent { createdAt reason actor { login } }
        }
      }
    }
  }
}`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { clientMutationId }
}`;
const DEQUEUE = `mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { clientMutationId }
}`;

function viewOf(p: Standing): MergeQueueView {
  const entry = p.mergeQueueEntry;
  const last = p.timelineItems.nodes[0];
  const left = !entry && last?.__typename === "RemovedFromMergeQueueEvent" && last.createdAt;
  const entries = p.mergeQueue?.entries;
  return {
    enabled: p.mergeQueue !== null,
    entry: entry && {
      state: STATE[entry.state],
      position: entry.position,
      enqueuedAt: entry.enqueuedAt,
      enqueuedBy: entry.enqueuer?.login ?? null,
      estimate: entry.estimatedTimeToMerge,
    },
    ahead: entry
      ? (entries?.nodes ?? [])
          .flatMap((n) => (n?.pullRequest && n.position < entry.position ? [n] : []))
          .sort((a, b) => a.position - b.position)
          .map((n) => ({
            number: n.pullRequest?.number ?? 0,
            title: n.pullRequest?.title ?? "",
            state: STATE[n.state],
          }))
      : [],
    size: entries?.totalCount ?? null,
    removed: left
      ? { at: left, by: last.actor?.login ?? null, reason: last.reason?.trim() || null }
      : null,
  };
}

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
  /** `refused` when GitHub answered the query with errors and no pull request, not when it was unreached. */
  const read = async <T>(
    query: string,
    token: string,
    fullName: string,
    variables: { number: number; ahead?: number },
  ) => {
    const [owner, name] = fullName.split("/");
    const sent = await ask<InRepository<T>>(token, query, { owner, name, ...variables });
    const found = sent?.status === 200 ? (sent.body?.data?.repository?.pullRequest ?? null) : null;
    return { pull: found, refused: !found && (sent?.body?.errors?.length ?? 0) > 0 };
  };
  const pull = async (token: string, fullName: string, number: number) =>
    (await read<Pull>(PULL, token, fullName, { number })).pull;
  return {
    async status(token, fullName, number) {
      const standing = await read<Standing>(STANDING, token, fullName, {
        number,
        ahead: MAX_QUEUE_AHEAD,
      });
      if (standing.pull) return viewOf(standing.pull);
      if (!standing.refused) return null;
      // A GitHub that lacks a field of the fuller read still says where the pull request stands.
      const p = await pull(token, fullName, number);
      if (!p) return null;
      const entry = p.mergeQueueEntry;
      return {
        enabled: p.mergeQueue !== null,
        entry: entry && {
          state: STATE[entry.state],
          position: entry.position,
          enqueuedAt: null,
          enqueuedBy: null,
          estimate: null,
        },
        ahead: [],
        size: null,
        removed: null,
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

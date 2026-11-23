import type { PullActions } from "./actions.js";
import { type LineFix, repoFilePath } from "./fix.js";
import type { GithubGraphql } from "./github-host.js";
import { githubSuggestions, newSideTail } from "./suggestions.js";
import {
  actionOf,
  applicableOf,
  findingsOfSuggestions,
  findingsOfThread,
  MAX_THREAD_COMMENTS,
  MAX_THREADS,
  type PullThreads,
  type Suggestion,
  suggestionMessage,
  type Thread,
} from "./threads.js";

// GitHub's review threads through GraphQL. A suggestion replaces the lines
// its thread is on, startLine to line, and only a comment with one block can
// be applied, on a thread that is not outdated. It is committed through the
// same contents API path as a finding's fix, with the lines the comment was
// written on (the end of its diff hunk) checked against the file at head.
// The contents API commits one file, so suggestions applied together are on one file.

type Side = "LEFT" | "RIGHT";
type Node = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: Side;
  startDiffSide: Side | null;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: {
    totalCount: number;
    nodes: {
      id: string;
      author: { login: string } | null;
      body: string;
      createdAt: string | null;
      diffHunk: string;
    }[];
  };
};
type Listed = {
  data?: {
    repository: {
      pullRequest: {
        headRefOid: string;
        reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: Node[] };
      } | null;
    } | null;
  } | null;
};
type Mutated = { data?: unknown; errors?: unknown[] };

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: ${MAX_THREADS}) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine
          diffSide startDiffSide viewerCanResolve viewerCanUnresolve
          comments(first: ${MAX_THREAD_COMMENTS}) {
            totalCount
            nodes { id author { login } body createdAt diffHunk }
          }
        }
      }
    }
  }
}`;
const RESOLVE = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
const UNRESOLVE = `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
const REPLY = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;

type GithubSuggestion = Suggestion & { path: string; fix: LineFix };

function threadOf(node: Node): Thread & { comments: { suggestions: GithubSuggestion[] }[] } {
  const end = node.line ?? node.originalLine ?? 1;
  const start = node.line === null ? (node.originalStartLine ?? end) : (node.startLine ?? end);
  const originalEnd = node.originalLine ?? end;
  const span = originalEnd - (node.originalStartLine ?? originalEnd) + 1;
  // The lines the thread was written on: the root comment's hunk ends on its last line.
  const expected = newSideTail(node.comments.nodes[0]?.diffHunk ?? "", span);
  const onHead =
    !node.isOutdated &&
    node.line !== null &&
    node.diffSide === "RIGHT" &&
    (node.startDiffSide ?? "RIGHT") === "RIGHT" &&
    end - start + 1 === span &&
    expected !== undefined &&
    repoFilePath(node.path) !== undefined;
  return {
    id: node.id,
    path: node.path,
    line: node.isOutdated ? null : node.line,
    startLine: node.isOutdated ? null : node.startLine,
    side: node.diffSide === "LEFT" ? "old" : "new",
    resolved: node.isResolved,
    outdated: node.isOutdated,
    canResolve: node.isResolved ? node.viewerCanUnresolve : node.viewerCanResolve,
    comments: node.comments.nodes.map((c) => {
      const blocks = githubSuggestions(c.body);
      return {
        id: c.id,
        author: c.author?.login ?? null,
        body: c.body,
        createdAt: c.createdAt,
        suggestions: blocks.map((replacement, i) => ({
          id: `${c.id}:${i}`,
          startLine: start,
          endLine: end,
          replacement,
          // GitHub applies a comment's suggestion only when it is its one block.
          applicable: onHead && blocks.length === 1,
          applied: false,
          path: node.path,
          fix: { startLine: start, endLine: end, replacement, ...(expected ? { expected } : {}) },
        })),
      };
    }),
  };
}

export function githubThreads(
  post: GithubGraphql,
  actions: Pick<PullActions, "applyFixes">,
): PullThreads {
  const read = async (token: string, fullName: string, number: number) => {
    const [owner, name] = fullName.split("/");
    const answer = await post(token)<Listed>({
      query: THREADS,
      variables: { owner, name, number },
    });
    const pull = answer?.data?.repository?.pullRequest;
    if (!pull) return null;
    const nodes = pull.reviewThreads.nodes;
    return {
      head: pull.headRefOid,
      threads: nodes.map(threadOf),
      truncated:
        pull.reviewThreads.pageInfo.hasNextPage ||
        nodes.some((n) => n.comments.totalCount > n.comments.nodes.length),
    };
  };
  return {
    list: read,
    async apply(token, fullName, number, apply) {
      const listing = await read(token, fullName, number);
      if (!listing) return null;
      if (listing.head !== apply.head) return actionOf("head_moved");
      const picked = applicableOf(listing.threads, apply.ids);
      if (!picked) return actionOf("not_applicable");
      const paths = new Set(picked.map((s) => s.path));
      const [path] = paths;
      if (paths.size !== 1 || !path) return actionOf("refused");
      const commit = await actions.applyFixes(token, fullName, number, {
        head: apply.head,
        files: [{ path, fixes: picked.map((s) => s.fix) }],
        message: () => suggestionMessage(picked.length),
      });
      return actionOf(commit?.outcome ?? null, findingsOfSuggestions(listing.threads, apply.ids));
    },
    async resolve(token, fullName, number, thread, resolved) {
      // Thread ids are global: one of another pull request's is not acted on from this one.
      const listing = await read(token, fullName, number);
      if (!listing) return null;
      const found = listing.threads.find((t) => t.id === thread);
      // GitHub says whether the viewer may; one who may not is refused unsent.
      if (!found || (found.resolved !== resolved && !found.canResolve)) return actionOf("refused");
      const findings = findingsOfThread(found);
      if (found.resolved === resolved) return actionOf("done", findings);
      const answer = await post(token)<Mutated>({
        query: resolved ? RESOLVE : UNRESOLVE,
        variables: { id: thread },
      });
      if (!answer) return null;
      return actionOf(answer.errors?.length ? "refused" : "done", findings);
    },
    async reply(token, fullName, number, thread, body) {
      // As a resolve: a thread of another pull request is not replied to from this one.
      const listing = await read(token, fullName, number);
      if (!listing) return null;
      if (!listing.threads.some((t) => t.id === thread)) return "refused";
      const answer = await post(token)<Mutated>({
        query: REPLY,
        variables: { id: thread, body },
      });
      if (!answer) return null;
      return answer.errors?.length ? "refused" : "done";
    },
  };
}

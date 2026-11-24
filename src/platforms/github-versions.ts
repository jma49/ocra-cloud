import { MAX_CHANGED_FILES, type PatchedFile } from "./changes.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { platformCall } from "./http.js";
import { compareCall, type SinceDiff } from "./since.js";
import type { PlatformVersion, PullVersions } from "./versions.js";

// GitHub keeps no list of a pull request's pushes, only its timeline's force
// pushes, each with the head before and after it; a fast forward push shows
// as commits, which say when they were made, not pushed. So its versions
// are the heads either side of each force push and the current head; the
// webhooks kept the others. Two versions where one is no ancestor of the
// other compare tree to tree (git's trees API), with no diff text.

/** The newest force pushes read. */
const MAX_PUSHES = 100;

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) { nodes { commit { committedDate } } }
      timelineItems(last: ${MAX_PUSHES}, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        totalCount
        nodes {
          ... on HeadRefForcePushedEvent {
            createdAt
            beforeCommit { oid committedDate }
            afterCommit { oid committedDate }
          }
        }
      }
    }
  }
}`;

type Commit = { oid: string; committedDate: string } | null;
type Answer = {
  data?: {
    repository?: {
      pullRequest?: {
        headRefOid: string;
        commits: { nodes: { commit: { committedDate: string } }[] };
        timelineItems: {
          totalCount: number;
          nodes: ({ createdAt?: string; beforeCommit?: Commit; afterCommit?: Commit } | null)[];
        };
      } | null;
    } | null;
  };
};

type TreeEntry = { path: string; type: string; sha: string };
type Tree = { tree?: TreeEntry[]; truncated?: boolean };

/** A file that differs between two trees: which lines, the trees API does not say. */
const treeFile = (
  path: string,
  status: PatchedFile["status"],
  blob: string | null,
): PatchedFile => ({
  path,
  oldPath: path,
  status,
  additions: 0,
  deletions: 0,
  patch: null,
  version: blob,
});

const dateOf = (text: string | undefined | null): Date | null => {
  const ms = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
};

export function githubVersions(host: GithubHost, post: GithubGraphql): PullVersions {
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;

  /** The commit's files, by path to blob (or submodule commit) id. */
  async function filesOf(token: string, fullName: string, commit: string) {
    const headers = githubHeaders(token);
    const read = await platformCall<{ tree?: { sha?: string } }>(
      `${repo(fullName)}/git/commits/${commit}`,
      { headers },
    );
    const tree = read?.tree?.sha;
    if (!tree) return null;
    const listed = await compareCall<Tree>(
      `${repo(fullName)}/git/trees/${tree}?recursive=1`,
      headers,
    );
    if (!listed?.tree) return null;
    const files = new Map<string, string>();
    for (const e of listed.tree) if (e.type !== "tree") files.set(e.path, e.sha);
    return { files, truncated: listed.truncated === true };
  }

  return {
    async list(token, fullName, number) {
      const [owner, name] = fullName.split("/");
      const answer = await post(token)<Answer>({
        query: QUERY,
        variables: { owner, name, number },
      });
      const pull = answer?.data?.repository?.pullRequest;
      if (!pull) return null;
      const versions: PlatformVersion[] = [];
      for (const push of pull.timelineItems.nodes) {
        const pushedAt = dateOf(push?.createdAt);
        if (!push || !pushedAt) continue;
        const before = push.beforeCommit;
        const beforeAt = dateOf(before?.committedDate);
        if (before && beforeAt) {
          versions.push({ head: before.oid, pushedAt: null, at: beforeAt, rewrite: null });
        }
        if (push.afterCommit) {
          versions.push({ head: push.afterCommit.oid, pushedAt, at: pushedAt, rewrite: true });
        }
      }
      const last = dateOf(pull.commits.nodes[0]?.commit.committedDate);
      if (last) versions.push({ head: pull.headRefOid, pushedAt: null, at: last, rewrite: null });
      return {
        versions: versions.map((v) => ({ ...v, head: v.head.toLowerCase() })),
        fromStart: false,
        namesRewrites: pull.timelineItems.totalCount <= MAX_PUSHES,
      };
    },

    async trees(token, fullName, from, to): Promise<SinceDiff | null> {
      const [old, now] = await Promise.all([
        filesOf(token, fullName, from),
        filesOf(token, fullName, to),
      ]);
      if (!old || !now) return null;
      const files: PatchedFile[] = [];
      for (const [path, sha] of now.files) {
        const was = old.files.get(path);
        if (was !== sha) files.push(treeFile(path, was === undefined ? "added" : "modified", sha));
      }
      for (const path of old.files.keys()) {
        if (!now.files.has(path)) files.push(treeFile(path, "removed", null));
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return {
        state: "changes",
        files: files.slice(0, MAX_CHANGED_FILES),
        truncated: old.truncated || now.truncated || files.length > MAX_CHANGED_FILES,
      };
    },
  };
}

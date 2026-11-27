import type { RepoContents, TreeEntry } from "./contents.js";
import { gitlabHeaders } from "./gitlab-changes.js";
import { boundedBytes, platformCall, platformRead } from "./http.js";

type Project = { id: number; path_with_namespace: string; default_branch?: string | null };
type Branch = { commit: { id: string } };
type Node = { id: string; path: string; type: string; mode: string };

const PER_PAGE = 100;
/** 50,000 files: past it the tree is reported truncated rather than read on. */
const MAX_TREE_PAGES = 500;
const REGULAR = new Set(["100644", "100755"]);

export function gitlabContents(origin: string): RepoContents {
  const api = `${origin}/api/v4`;
  return {
    async head(token, fullName) {
      const project = await platformCall<Project>(
        `${api}/projects/${encodeURIComponent(fullName)}`,
        { headers: gitlabHeaders(token) },
      );
      if (!project?.default_branch) return null;
      const branch = await platformCall<Branch>(
        `${api}/projects/${project.id}/repository/branches/${encodeURIComponent(project.default_branch)}`,
        { headers: gitlabHeaders(token) },
      );
      if (!branch) return null;
      return {
        platformRepoId: String(project.id),
        fullName: project.path_with_namespace,
        branch: project.default_branch,
        commit: branch.commit.id,
      };
    },
    async tree(token, repo, commit, signal) {
      const entries: TreeEntry[] = [];
      let next: string | null =
        `${api}/projects/${encodeURIComponent(repo.platformRepoId)}/repository/tree?ref=${commit}&recursive=true&per_page=${PER_PAGE}&pagination=keyset`;
      for (let page = 0; next && page < MAX_TREE_PAGES; page++) {
        const answer: { nodes: Node[]; next: string | null } | null = await platformRead(
          next,
          { headers: gitlabHeaders(token) },
          async (res) => ({ nodes: (await res.json()) as Node[], next: nextLink(res, origin) }),
          signal,
        );
        if (!answer) return null;
        for (const n of answer.nodes) {
          if (n.type === "blob" && REGULAR.has(n.mode))
            entries.push({ path: n.path, blobId: n.id });
        }
        next = answer.next;
      }
      return { entries, truncated: next !== null };
    },
    async blob(token, repo, blobId, maxBytes, signal) {
      const bytes = await platformRead(
        `${api}/projects/${encodeURIComponent(repo.platformRepoId)}/repository/blobs/${blobId}/raw`,
        { headers: gitlabHeaders(token) },
        (res) => boundedBytes(res, maxBytes),
        signal,
      );
      return bytes ?? undefined;
    },
  };
}

/** The Link header's next page, only on the instance's own origin: the token goes with it. */
function nextLink(res: Response, origin: string): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  if (!match?.[1]) return null;
  const url = new URL(match[1]);
  return url.origin === origin ? url.toString() : null;
}

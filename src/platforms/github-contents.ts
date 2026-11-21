import type { RepoContents, RepoTree } from "./contents.js";
import { boundedBytes, platformCall, platformRead } from "./http.js";

const API = "https://api.github.com";

type Repo = { id: number; full_name: string; default_branch?: string };
type Branch = { commit: { sha: string } };
type Tree = {
  truncated: boolean;
  tree: { path: string; mode: string; type: string; sha: string; size?: number }[];
};

// 100644 and 100755: symbolic links (120000) and submodules (160000) are not files.
const REGULAR = new Set(["100644", "100755"]);

export function githubContents(): RepoContents {
  const headers = (token: string, accept = "application/vnd.github+json") => ({
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "ocra-cloud",
  });
  const path = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");
  return {
    async head(token, fullName) {
      const repo = await platformCall<Repo>(`${API}/repos/${path(fullName)}`, {
        headers: headers(token),
      });
      if (!repo?.default_branch) return null;
      const branch = await platformCall<Branch>(
        `${API}/repos/${path(repo.full_name)}/branches/${encodeURIComponent(repo.default_branch)}`,
        { headers: headers(token) },
      );
      if (!branch) return null;
      return {
        platformRepoId: String(repo.id),
        fullName: repo.full_name,
        branch: repo.default_branch,
        commit: branch.commit.sha,
      };
    },
    async tree(token, repo, commit, signal) {
      const tree = await platformRead(
        `${API}/repos/${path(repo.fullName)}/git/trees/${commit}?recursive=1`,
        { headers: headers(token) },
        (res) => res.json() as Promise<Tree>,
        signal,
      );
      if (!tree) return null;
      return {
        truncated: tree.truncated,
        entries: tree.tree
          .filter((e) => e.type === "blob" && REGULAR.has(e.mode))
          .map((e) => ({
            path: e.path,
            blobId: e.sha,
            ...(e.size === undefined ? {} : { size: e.size }),
          })),
      } satisfies RepoTree;
    },
    async blob(token, repo, blobId, maxBytes, signal) {
      const bytes = await platformRead(
        `${API}/repos/${path(repo.fullName)}/git/blobs/${blobId}`,
        { headers: headers(token, "application/vnd.github.raw+json") },
        (res) => boundedBytes(res, maxBytes),
        signal,
      );
      return bytes ?? undefined;
    },
  };
}

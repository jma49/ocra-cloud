import { LEARNING_PROPOSAL_BRANCH, LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { platformCall, platformSend } from "./http.js";
import { MAX_PROPOSALS, type RepoLearnings } from "./learnings.js";

const API = "https://api.github.com";

type DirEntry = { type: string; path: string; sha: string };
type Pull = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
};

export function githubLearnings(): RepoLearnings {
  const repoUrl = (fullName: string) => `${API}/repos/${githubRepoPath(fullName)}`;
  const send = (token: string, method: string, url: string, body?: unknown) =>
    platformSend<Record<string, unknown>>(url, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    async list(token, repo, commit) {
      const sent = await send(
        token,
        "GET",
        `${repoUrl(repo.fullName)}/contents/${LEARNINGS_DIR}?ref=${commit}`,
      );
      if (!sent) return null;
      if (sent.status === 404) return [];
      if (sent.status !== 200) return null;
      // A file where the directory should be lists as an object: no learnings.
      if (!Array.isArray(sent.body)) return [];
      return (sent.body as DirEntry[])
        .filter((e) => e.type === "file")
        .map((e) => ({ path: e.path, blobId: e.sha }));
    },
    async proposals(token, repo, base) {
      const pulls = await platformCall<Pull[]>(
        `${repoUrl(repo.fullName)}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&sort=created&direction=desc`,
        { headers: githubHeaders(token) },
      );
      if (!pulls) return null;
      // Only the repository's own branches: a fork may name a branch anything.
      const own = pulls.filter(
        (p) =>
          p.head.ref.startsWith(LEARNING_PROPOSAL_BRANCH) &&
          p.head.repo?.full_name === repo.fullName,
      );
      return {
        more: own.length > MAX_PROPOSALS,
        proposals: own.slice(0, MAX_PROPOSALS).map((p) => ({
          number: p.number,
          title: p.title,
          url: p.html_url,
          branch: p.head.ref,
          head: p.head.sha,
          author: p.user?.login ?? null,
          createdAt: p.created_at,
        })),
      };
    },
  };
}

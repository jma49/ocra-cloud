import { LEARNING_PROPOSAL_BRANCH, LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import { gitlabHeaders } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import { type LearningEntry, MAX_PROPOSALS, type RepoLearnings } from "./learnings.js";

type Node = { id: string; path: string; type: string; mode: string };
type MergeRequest = {
  iid: number;
  title: string;
  web_url: string;
  created_at: string;
  sha: string;
  source_branch: string;
  source_project_id: number;
  author: { username: string } | null;
};

const PER_PAGE = 100;
/** The contract's 500 learnings, at 100 a page. */
const MAX_TREE_PAGES = 5;
const REGULAR = new Set(["100644", "100755"]);

export function gitlabLearnings(origin: string): RepoLearnings {
  const api = `${origin}/api/v4`;
  const project = (id: string) => `${api}/projects/${encodeURIComponent(id)}`;
  const send = (token: string, method: string, url: string, body?: unknown) =>
    platformSend<Record<string, unknown>>(url, {
      method,
      headers: {
        ...gitlabHeaders(token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    async list(token, repo, commit) {
      const entries: LearningEntry[] = [];
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const sent = await send(
          token,
          "GET",
          `${project(repo.platformRepoId)}/repository/tree?path=${encodeURIComponent(LEARNINGS_DIR)}&ref=${commit}&per_page=${PER_PAGE}&page=${page}`,
        );
        if (!sent) return null;
        if (sent.status === 404) return entries;
        if (sent.status !== 200 || !Array.isArray(sent.body)) return null;
        const nodes = sent.body as Node[];
        for (const n of nodes) {
          if (n.type === "blob" && REGULAR.has(n.mode))
            entries.push({ path: n.path, blobId: n.id });
        }
        if (nodes.length < PER_PAGE) break;
      }
      return entries;
    },
    async proposals(token, repo, base) {
      const mrs = await platformCall<MergeRequest[]>(
        `${project(repo.platformRepoId)}/merge_requests?state=opened&target_branch=${encodeURIComponent(base)}&per_page=100&order_by=created_at`,
        { headers: gitlabHeaders(token) },
      );
      if (!mrs) return null;
      // Only the project's own branches: a fork may name a branch anything.
      const own = mrs.filter(
        (m) =>
          m.source_branch.startsWith(LEARNING_PROPOSAL_BRANCH) &&
          String(m.source_project_id) === repo.platformRepoId,
      );
      return {
        more: own.length > MAX_PROPOSALS,
        proposals: own.slice(0, MAX_PROPOSALS).map((m) => ({
          number: m.iid,
          title: m.title,
          url: m.web_url,
          branch: m.source_branch,
          head: m.sha,
          author: m.author?.username ?? null,
          createdAt: m.created_at,
        })),
      };
    },
  };
}

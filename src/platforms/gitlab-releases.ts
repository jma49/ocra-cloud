import { gitlabHeaders } from "./gitlab-changes.js";
import { platformJson } from "./http.js";
import {
  isSha,
  isUnder,
  MAX_COMPARE_BYTES,
  type RangePull,
  type RepoReleases,
  refPath,
  saysBreaking,
} from "./releases.js";

// GitLab: the range's commits from one compare call, then the merge
// requests merged since its oldest commit, matched to the range by their
// merge, squash or head commit (a fast-forward merge has only the head).
// GitLab keeps no draft releases: a release makes its tag at once, so a
// draft is never sent there.

const MR_PAGES = 3;
const PER_PAGE = 100;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** A committer's clock may run behind the merge's. */
const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000;

type Compare = { commits?: { id?: unknown; committed_date?: unknown }[] };
type MergeRequest = {
  iid?: unknown;
  title?: unknown;
  web_url?: unknown;
  merged_at?: unknown;
  description?: unknown;
  merge_commit_sha?: unknown;
  squash_commit_sha?: unknown;
  sha?: unknown;
  author?: { username?: unknown } | null;
};

export function gitlabReleases(origin: string): RepoReleases {
  const project = (fullName: string) => `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
  return {
    drafts: false,
    async mergedBetween(token, fullName, from, to, max) {
      const query = new URLSearchParams({ from, to });
      const compared = await platformJson<Compare>(
        `${project(fullName)}/repository/compare?${query}`,
        { headers: gitlabHeaders(token) },
        MAX_COMPARE_BYTES,
      );
      if (!compared) return null;
      if (compared.status === 404 || compared.status === 400) return "missing";
      if (compared.status !== 200 || !compared.body) return null;
      const commits = compared.body.commits ?? [];
      const inRange = new Set(commits.map((c) => c.id).filter(isSha));
      const times = commits
        .map((c) => (typeof c.committed_date === "string" ? Date.parse(c.committed_date) : NaN))
        .filter(Number.isFinite);
      const compareUrl = `${origin}/${fullName.split("/").map(encodeURIComponent).join("/")}/-/compare/${refPath(from)}...${refPath(to)}`;
      if (inRange.size === 0 || times.length === 0)
        return { pulls: [], truncated: false, compareUrl };
      const since = new Date(Math.min(...times) - CLOCK_SLACK_MS).toISOString();
      const found = new Map<number, RangePull>();
      let full = false;
      for (let page = 1; page <= MR_PAGES; page++) {
        const listed = await platformJson<MergeRequest[]>(
          `${project(fullName)}/merge_requests?${new URLSearchParams({
            state: "merged",
            updated_after: since,
            order_by: "updated_at",
            sort: "asc",
            per_page: String(PER_PAGE),
            page: String(page),
          })}`,
          { headers: gitlabHeaders(token) },
          MAX_PAGE_BYTES,
        );
        if (listed?.status !== 200 || !Array.isArray(listed.body)) return null;
        for (const mr of listed.body) {
          const n = mr.iid;
          const merged = [mr.merge_commit_sha, mr.squash_commit_sha, mr.sha].some(
            (s) => isSha(s) && inRange.has(s),
          );
          if (!merged || typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) continue;
          if (found.has(n) || typeof mr.title !== "string" || !isUnder(mr.web_url, origin))
            continue;
          const login = mr.author?.username;
          found.set(n, {
            number: n,
            title: mr.title,
            url: mr.web_url,
            author: typeof login === "string" ? login : null,
            mergedAt: typeof mr.merged_at === "string" ? mr.merged_at : null,
            breakingNote: saysBreaking(mr.description as string | null),
          });
        }
        full = listed.body.length === PER_PAGE;
        if (!full) break;
      }
      const pulls = [...found.values()].sort((a, b) => a.number - b.number);
      return { pulls: pulls.slice(0, max), truncated: full || pulls.length > max, compareUrl };
    },
    saveDraft: async () => ({ outcome: "unsupported" }),
  };
}

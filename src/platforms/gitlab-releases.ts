import type { HeldReleasePublishAnswer } from "../shared/index.js";
import { gitlabHeaders } from "./gitlab-changes.js";
import { platformJson, platformSend } from "./http.js";
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
// GitLab keeps no draft releases: a release makes its tag at once, and one
// with a future released_at ("upcoming") is still a published release with
// its tag. So ocra Cloud holds the draft (src/db/release-drafts.ts); GitLab
// is asked to check its tag and target, and makes the release on publish.

const MR_PAGES = 3;
const PER_PAGE = 100;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** A committer's clock may run behind the merge's. */
const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000;

type Compare = { commits?: { id?: unknown; committed_date?: unknown }[] };
type Release = { _links?: { self?: unknown } | null };

const isRefused = (status: number) => status === 401 || status === 403;

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
  const repo = (fullName: string) =>
    `${origin}/${fullName.split("/").map(encodeURIComponent).join("/")}`;

  async function checkDraft(
    token: string,
    fullName: string,
    draft: { tag: string; target: string },
  ): Promise<"ok" | "tag_exists" | "target_missing" | "refused" | null> {
    const headers = gitlabHeaders(token);
    const target = await platformSend(
      `${project(fullName)}/repository/commits/${encodeURIComponent(draft.target)}`,
      { headers },
    );
    if (!target) return null;
    if (target.status === 404) return "target_missing";
    if (isRefused(target.status)) return "refused";
    if (target.status !== 200) return null;
    // A release on a tag of that name would be someone else's tag.
    const tag = await platformSend(
      `${project(fullName)}/repository/tags/${encodeURIComponent(draft.tag)}`,
      { headers },
    );
    if (!tag) return null;
    if (tag.status === 200) return "tag_exists";
    if (tag.status === 404) return "ok";
    return isRefused(tag.status) ? "refused" : null;
  }

  return {
    drafts: "held",
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
      const compareUrl = `${repo(fullName)}/-/compare/${refPath(from)}...${refPath(to)}`;
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
    checkDraft,

    async release(token, fullName, draft): Promise<HeldReleasePublishAnswer | null> {
      const checked = await checkDraft(token, fullName, draft);
      if (checked !== "ok") return checked && { outcome: checked };
      const sent = await platformSend<Release>(`${project(fullName)}/releases`, {
        method: "POST",
        headers: { ...gitlabHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({
          tag_name: draft.tag,
          ref: draft.target,
          name: draft.name,
          description: draft.body,
        }),
      });
      if (!sent) return null;
      if (sent.status === 409) return { outcome: "tag_exists" };
      if (isRefused(sent.status)) return { outcome: "refused" };
      if (sent.status === 400 || sent.status === 422) return { outcome: "target_missing" };
      if (sent.status !== 201 && sent.status !== 200) return null;
      const self = sent.body?._links?.self;
      return {
        outcome: "published",
        url: isUnder(self, origin) ? self : `${repo(fullName)}/-/releases`,
      };
    },
  };
}

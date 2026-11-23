import type { ReleasePublishAnswer } from "../shared/index.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformJson, platformSend } from "./http.js";
import {
  isSha,
  isUnder,
  MAX_COMPARE_BYTES,
  MAX_RANGE_COMMITS,
  type RangePull,
  type RepoReleases,
  refPath,
  saysBreaking,
} from "./releases.js";

// GitHub: the range's commits from one compare call, then their pull
// requests in one GraphQL query; a pull request counts when it was merged
// as a commit of the range (its merge, squash or last rebased commit), so
// one merged elsewhere and only sharing commits is left out.

const PULLS_PER_COMMIT = 5;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

type Compare = { total_commits?: number; commits?: { sha?: unknown }[] };
type PullNode = {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  merged?: unknown;
  mergedAt?: unknown;
  body?: unknown;
  mergeCommit?: { oid?: unknown } | null;
  author?: { login?: unknown } | null;
};
type Graphql = {
  data?: {
    repository?: Record<string, { associatedPullRequests?: { nodes?: PullNode[] } } | null>;
  };
};
type Release = { id?: unknown; tag_name?: unknown; draft?: unknown; html_url?: unknown };

const isRefused = (status: number) => status >= 400 && status < 500 && status !== 429;

export function githubReleases(host: GithubHost): RepoReleases {
  const repoApi = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  const json = { "content-type": "application/json" };

  async function pullsOf(token: string, fullName: string, shas: string[]) {
    const [owner, name] = fullName.split("/");
    const fields = shas.map(
      (sha, i) =>
        `c${i}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: ${PULLS_PER_COMMIT}) { nodes { number title url merged mergedAt body mergeCommit { oid } author { login } } } } }`,
    );
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;
    const sent = await platformJson<Graphql>(
      host.graphql,
      {
        method: "POST",
        headers: { ...githubHeaders(token), accept: "application/json", ...json },
        body: JSON.stringify({ query, variables: { owner, name } }),
      },
      MAX_ANSWER_BYTES,
    );
    const repository = sent?.status === 200 ? sent.body?.data?.repository : undefined;
    return repository ? Object.values(repository) : null;
  }

  return {
    drafts: "platform",
    async mergedBetween(token, fullName, from, to, max) {
      const compared = await platformJson<Compare>(
        `${repoApi(fullName)}/compare/${refPath(from)}...${refPath(to)}?per_page=${MAX_RANGE_COMMITS}`,
        { headers: githubHeaders(token) },
        MAX_COMPARE_BYTES,
      );
      if (!compared) return null;
      if (compared.status === 404 || compared.status === 422) return "missing";
      if (compared.status !== 200 || !compared.body) return null;
      const shas = (compared.body.commits ?? [])
        .map((c) => c.sha)
        .filter(isSha)
        .slice(0, MAX_RANGE_COMMITS);
      const inRange = new Set(shas);
      const commits = shas.length === 0 ? [] : await pullsOf(token, fullName, shas);
      if (!commits) return null;
      const found = new Map<number, RangePull>();
      for (const node of commits.flatMap((c) => c?.associatedPullRequests?.nodes ?? [])) {
        const n = node.number;
        const oid = node.mergeCommit?.oid;
        if (node.merged !== true || typeof oid !== "string" || !inRange.has(oid)) continue;
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || found.has(n)) continue;
        if (typeof node.title !== "string" || !isUnder(node.url, host.url)) continue;
        const login = node.author?.login;
        found.set(n, {
          number: n,
          title: node.title,
          url: node.url,
          author: typeof login === "string" ? login : null,
          mergedAt: typeof node.mergedAt === "string" ? node.mergedAt : null,
          breakingNote: saysBreaking(node.body as string | null),
        });
      }
      const pulls = [...found.values()].sort((a, b) => a.number - b.number);
      const total = compared.body.total_commits;
      return {
        pulls: pulls.slice(0, max),
        truncated: pulls.length > max || (typeof total === "number" && total > shas.length),
        compareUrl: `${host.url}/${githubRepoPath(fullName)}/compare/${refPath(from)}...${refPath(to)}`,
      };
    },

    async saveDraft(token, fullName, draft): Promise<ReleasePublishAnswer | null> {
      const api = repoApi(fullName);
      const headers = githubHeaders(token);
      const target = await platformSend(`${api}/commits/${refPath(draft.target)}`, {
        headers: { ...headers, accept: "application/vnd.github.sha" },
      });
      if (!target) return null;
      if (target.status === 404 || target.status === 422) return { outcome: "target_missing" };
      if (isRefused(target.status)) return { outcome: "refused" };
      if (target.status !== 200) return null;

      const listed = await platformJson<Release[]>(
        `${api}/releases?per_page=100`,
        { headers },
        MAX_ANSWER_BYTES,
      );
      if (!listed) return null;
      if (isRefused(listed.status)) return { outcome: "refused" };
      if (listed.status !== 200 || !Array.isArray(listed.body)) return null;
      const same = listed.body.find((r) => r.tag_name === draft.tag);
      const edit = { name: draft.name, body: draft.body, target_commitish: draft.target };
      if (same) {
        if (same.draft !== true || typeof same.id !== "number") return { outcome: "tag_exists" };
        const updated = await platformSend<Release>(`${api}/releases/${same.id}`, {
          method: "PATCH",
          headers: { ...headers, ...json },
          body: JSON.stringify(edit),
        });
        return answered(updated, "updated", fullName);
      }

      // A draft makes no tag until it is published, so a tag of that name is someone else's.
      const tag = await platformSend(`${api}/git/ref/tags/${refPath(draft.tag)}`, { headers });
      if (!tag) return null;
      if (tag.status === 200) return { outcome: "tag_exists" };
      if (tag.status !== 404) return isRefused(tag.status) ? { outcome: "refused" } : null;
      const created = await platformSend<Release>(`${api}/releases`, {
        method: "POST",
        headers: { ...headers, ...json },
        body: JSON.stringify({ tag_name: draft.tag, ...edit, draft: true }),
      });
      return answered(created, "created", fullName);
    },
  };

  function answered(
    sent: { status: number; body: Release | null } | null,
    outcome: "created" | "updated",
    fullName: string,
  ): ReleasePublishAnswer | null {
    if (!sent) return null;
    if (isRefused(sent.status)) return { outcome: "refused" };
    const id = sent.body?.id;
    if (sent.status < 200 || sent.status >= 300 || typeof id !== "number") return null;
    const url = isUnder(sent.body?.html_url, host.url)
      ? (sent.body?.html_url as string)
      : `${host.url}/${githubRepoPath(fullName)}/releases`;
    return { outcome, release: { id, url } };
  }
}

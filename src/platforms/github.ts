import { githubActions } from "./github-actions.js";
import { githubAutoMerge } from "./github-auto-merge.js";
import { githubChanges } from "./github-changes.js";
import { githubContents } from "./github-contents.js";
import { githubCycles } from "./github-cycles.js";
import { githubEdits } from "./github-edits.js";
import { githubFiles } from "./github-files.js";
import type { GithubHost } from "./github-host.js";
import { githubIssues } from "./github-issues.js";
import { githubLearnings } from "./github-learnings.js";
import { githubMergeStatus } from "./github-merge-status.js";
import { githubPulls } from "./github-pulls.js";
import { githubQueue } from "./github-queue.js";
import { githubReadiness } from "./github-readiness.js";
import { githubReviewers } from "./github-reviewers.js";
import { githubSearch } from "./github-search.js";
import { githubSince } from "./github-since.js";
import { githubStacks } from "./github-stack.js";
import { githubThreads } from "./github-threads.js";
import { githubViewed } from "./github-viewed.js";
import { platformCall } from "./http.js";
import type { CodePlatform, PlatformRepo, TokenAnswer } from "./platform.js";

// GitHub, github.com or a GitHub Enterprise Server, through this
// deployment's GitHub App: the user's expiring token (8 hours, with a
// single-use refresh token) reads the App's installations the user can see
// and their repositories.

/** Bounds the calls of one request (Workers' subrequest limit). */
const MAX_INSTALLATIONS = 10;

type Installation = { id: number };
type Repo = { id: number; full_name: string; private: boolean; html_url: string };

export type GithubClient = { host: GithubHost; id: string; secret: string; slug?: string };

export function github(client: GithubClient): CodePlatform {
  const { host } = client;
  const get = <T>(token: string, path: string) =>
    platformCall<T>(`${host.api}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ocra-cloud",
      },
    });
  const post =
    (token: string) =>
    <T>(body: unknown) =>
      platformCall<T>(host.graphql, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "ocra-cloud",
        },
        body: JSON.stringify(body),
      });
  const actions = githubActions(host);
  return {
    kind: "github",
    host: host.host,
    url: host.url,
    ...(client.slug
      ? { install: `${host.url}/apps/${encodeURIComponent(client.slug)}/installations/new` }
      : {}),
    refresh: (refreshToken) =>
      platformCall<TokenAnswer>(`${host.url}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: client.id,
          client_secret: client.secret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }),
    listPulls: (token) => githubPulls(post(token)),
    searchPulls: (token, search, limit) => githubSearch(post(token), search, limit),
    contents: githubContents(host),
    changes: githubChanges(host),
    since: githubSince(host, post),
    actions,
    queue: githubQueue(host),
    autoMerge: githubAutoMerge(host),
    cycles: githubCycles(post),
    stacks: githubStacks(host, post),
    learnings: githubLearnings(host),
    files: githubFiles(host, post),
    mergeStatus: githubMergeStatus(host),
    readiness: githubReadiness(host, post),
    reviewers: githubReviewers(host, post),
    threads: githubThreads(post, actions),
    edits: githubEdits(host, post, actions),
    issues: githubIssues(host),
    viewed: githubViewed(post),
    async listRepos(token) {
      const installs = await get<{ installations: Installation[] }>(
        token,
        "/user/installations?per_page=100",
      );
      if (!installs) return null;
      const picked = installs.installations.slice(0, MAX_INSTALLATIONS);
      const pages = await Promise.all(
        picked.map((i) =>
          get<{ repositories: Repo[] }>(
            token,
            `/user/installations/${i.id}/repositories?per_page=100`,
          ),
        ),
      );
      const seen = new Set<number>();
      const repositories: PlatformRepo[] = [];
      for (const r of pages.flatMap((p) => p?.repositories ?? [])) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        repositories.push({
          id: String(r.id),
          fullName: r.full_name,
          url: r.html_url,
          private: r.private,
        });
      }
      return {
        repositories,
        more:
          installs.installations.length > MAX_INSTALLATIONS ||
          pages.some((p) => (p?.repositories.length ?? 0) >= 100),
      };
    },
  };
}

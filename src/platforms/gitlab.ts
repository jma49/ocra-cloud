import { gitlabActions } from "./gitlab-actions.js";
import { gitlabChanges } from "./gitlab-changes.js";
import { gitlabContents } from "./gitlab-contents.js";
import { gitlabCycles } from "./gitlab-cycles.js";
import { gitlabFiles } from "./gitlab-files.js";
import { gitlabLearnings } from "./gitlab-learnings.js";
import { gitlabMergeStatus } from "./gitlab-merge-status.js";
import { gitlabPulls } from "./gitlab-pulls.js";
import { gitlabQueue } from "./gitlab-queue.js";
import { gitlabSearch } from "./gitlab-search.js";
import { gitlabStacks } from "./gitlab-stack.js";
import { platformCall } from "./http.js";
import type { CodePlatform, PlatformRepo, TokenAnswer } from "./platform.js";

// GitLab, gitlab.com or a self-hosted instance, through an OAuth
// application of this deployment: the user's token (2 hours, with a
// single-use refresh token) reads the projects they are a member of.

/** Bounds the calls of one request (Workers' subrequest limit). */
const MAX_PAGES = 5;

type Project = { id: number; path_with_namespace: string; web_url: string; visibility: string };

export type GitlabClient = { url: string; id: string; secret: string };

/** OAuth's token endpoint, for a code (connect) or a refresh token. */
export const gitlabToken = (client: GitlabClient, grant: Record<string, string>) =>
  platformCall<TokenAnswer>(`${client.url}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: client.id, client_secret: client.secret, ...grant }),
  });

/** The id of the user the token is of; null when GitLab does not say. */
export async function gitlabUserId(url: string, token: string): Promise<string | null> {
  const user = await platformCall<{ id?: unknown }>(`${url}/api/v4/user`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  return typeof user?.id === "number" && Number.isSafeInteger(user.id) ? String(user.id) : null;
}

export function gitlab(client: GitlabClient, redirectUri: string): CodePlatform {
  return {
    kind: "gitlab",
    host: new URL(client.url).host,
    url: client.url,
    refresh: (refreshToken) =>
      gitlabToken(client, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        redirect_uri: redirectUri,
      }),
    listPulls: (token) => gitlabPulls(client.url, token),
    searchPulls: (token, search, limit) => gitlabSearch(client.url, token, search, limit),
    contents: gitlabContents(client.url),
    changes: gitlabChanges(client.url),
    actions: gitlabActions(client.url),
    queue: gitlabQueue(client.url),
    cycles: gitlabCycles(client.url),
    stacks: gitlabStacks(client.url),
    learnings: gitlabLearnings(client.url),
    files: gitlabFiles(client.url),
    mergeStatus: gitlabMergeStatus(client.url),
    async listRepos(token) {
      const repositories: PlatformRepo[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const projects = await platformCall<Project[]>(
          `${client.url}/api/v4/projects?membership=true&simple=true&per_page=100&page=${page}&order_by=last_activity_at`,
          { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
        );
        if (!projects) return page === 1 ? null : { repositories, more: true };
        for (const p of projects) {
          repositories.push({
            id: String(p.id),
            fullName: p.path_with_namespace,
            url: p.web_url,
            private: p.visibility !== "public",
          });
        }
        if (projects.length < 100) return { repositories, more: false };
      }
      return { repositories, more: true };
    },
  };
}

import { githubActions } from "./github-actions.js";
import { githubChanges } from "./github-changes.js";
import { githubContents } from "./github-contents.js";
import { githubCycles } from "./github-cycles.js";
import { githubLearnings } from "./github-learnings.js";
import { githubPulls } from "./github-pulls.js";
import { githubQueue } from "./github-queue.js";
import { githubStacks } from "./github-stack.js";
import { platformCall } from "./http.js";
import type { CodePlatform, PlatformRepo, TokenAnswer } from "./platform.js";

// GitHub, through the ocra Cloud GitHub App: the user's expiring token
// (8 hours, with a single-use refresh token) reads the App's installations
// the user can see and their repositories.

const API = "https://api.github.com";
/** Bounds the calls of one request (Workers' subrequest limit). */
const MAX_INSTALLATIONS = 10;

type Installation = { id: number };
type Repo = { id: number; full_name: string; private: boolean; html_url: string };

export function github(client: { id: string; secret: string }): CodePlatform {
  const get = <T>(token: string, path: string) =>
    platformCall<T>(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ocra-cloud",
      },
    });
  const post =
    (token: string) =>
    <T>(path: string, body: unknown) =>
      platformCall<T>(`${API}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "ocra-cloud",
        },
        body: JSON.stringify(body),
      });
  return {
    kind: "github",
    host: "github.com",
    refresh: (refreshToken) =>
      platformCall<TokenAnswer>("https://github.com/login/oauth/access_token", {
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
    contents: githubContents(),
    changes: githubChanges(),
    actions: githubActions(),
    queue: githubQueue(),
    cycles: githubCycles(post),
    stacks: githubStacks(post),
    learnings: githubLearnings(post),
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

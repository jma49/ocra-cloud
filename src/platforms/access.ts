import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { gitlabHeaders } from "./gitlab-changes.js";
import { platformSend } from "./http.js";
import { LOGIN } from "./reviewers.js";

// Whether a person may push to a repository, read as the bot: what an @ocra
// command asks of its comment's author (src/auto-review/commands.ts). The
// platform answers from its own records; nothing in the comment is trusted.

export interface RepoAccess {
  /**
   * Whether the user (a GitHub login, a GitLab user id) may push: GitHub's
   * write, maintain or admin, GitLab's Developer or above. null when the
   * platform could not tell.
   */
  canWrite(token: string, fullName: string, user: string): Promise<boolean | null>;
}

/** GitLab's Developer role, the lowest that may push. */
const DEVELOPER = 30;
const GITLAB_USER = /^[1-9][0-9]{0,15}$/;

/** A read's status as an answer: 404 is not a collaborator or member, other failures unknown. */
const answered = (status: number) => (status === 404 ? false : null);

export function githubAccess(host: GithubHost): RepoAccess {
  return {
    async canWrite(token, fullName, login) {
      if (!LOGIN.test(login)) return false;
      const url = `${host.api}/repos/${githubRepoPath(fullName)}/collaborators/${encodeURIComponent(login)}/permission`;
      const res = await platformSend<{ permission?: unknown }>(url, {
        headers: githubHeaders(token),
      });
      if (!res) return null;
      if (res.status !== 200) return answered(res.status);
      const permission = res.body?.permission;
      return permission === "admin" || permission === "write";
    },
  };
}

export function gitlabAccess(origin: string): RepoAccess {
  return {
    async canWrite(token, fullName, userId) {
      if (!GITLAB_USER.test(userId)) return false;
      const url = `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/members/all/${userId}`;
      const res = await platformSend<{ access_level?: unknown; state?: unknown }>(url, {
        headers: gitlabHeaders(token),
      });
      if (!res) return null;
      if (res.status !== 200) return answered(res.status);
      const level = res.body?.access_level;
      return typeof level === "number" && level >= DEVELOPER && res.body?.state !== "blocked";
    },
  };
}

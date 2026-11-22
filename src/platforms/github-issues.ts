import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformSend } from "./http.js";
import { openedIssue, type RepoIssues } from "./issues.js";

export function githubIssues(host: GithubHost): RepoIssues {
  return {
    async open(token, fullName, issue) {
      const sent = await platformSend<Record<string, unknown>>(
        `${host.api}/repos/${githubRepoPath(fullName)}/issues`,
        {
          method: "POST",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ title: issue.title, body: issue.body }),
        },
      );
      return openedIssue(sent, "number");
    },
    pageUrl: (fullName, number) => `${host.url}/${githubRepoPath(fullName)}/issues/${number}`,
  };
}

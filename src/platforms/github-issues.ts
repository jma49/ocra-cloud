import { githubHeaders, githubRepoPath } from "./github-changes.js";
import { platformSend } from "./http.js";
import { openedIssue, type RepoIssues } from "./issues.js";

const API = "https://api.github.com";

export function githubIssues(): RepoIssues {
  return {
    async open(token, fullName, issue) {
      const sent = await platformSend<Record<string, unknown>>(
        `${API}/repos/${githubRepoPath(fullName)}/issues`,
        {
          method: "POST",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ title: issue.title, body: issue.body }),
        },
      );
      return openedIssue(sent, "number");
    },
    pageUrl: (fullName, number) =>
      `https://github.com/${githubRepoPath(fullName)}/issues/${number}`,
  };
}

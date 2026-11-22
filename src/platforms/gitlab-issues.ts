import { gitlabHeaders } from "./gitlab-changes.js";
import { platformSend } from "./http.js";
import { openedIssue, type RepoIssues } from "./issues.js";

export function gitlabIssues(origin: string): RepoIssues {
  return {
    async open(token, fullName, issue) {
      const sent = await platformSend<Record<string, unknown>>(
        `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/issues`,
        {
          method: "POST",
          headers: { ...gitlabHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ title: issue.title, description: issue.body }),
        },
      );
      return openedIssue(sent, "iid");
    },
    pageUrl: (fullName, number) =>
      `${origin}/${fullName.split("/").map(encodeURIComponent).join("/")}/-/issues/${number}`,
  };
}

import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { platformCall } from "./http.js";
import { isBotLogin, LOGIN, type PullReviewers } from "./reviewers.js";

type User = { login: string; type?: string };
type Pull = {
  user: User | null;
  base: { sha: string; repo: { id: number } };
  requested_reviewers?: User[];
};
type Searched = { data?: Record<string, { issueCount: number } | null> };

export function githubReviewers(host: GithubHost, post: GithubGraphql): PullReviewers {
  return {
    async people(token, fullName, number) {
      const pull = await platformCall<Pull>(
        `${host.api}/repos/${githubRepoPath(fullName)}/pulls/${number}`,
        { headers: githubHeaders(token) },
      );
      if (!pull) return null;
      const author = pull.user && pull.user.type !== "Bot" ? pull.user.login : null;
      return {
        platformRepoId: String(pull.base.repo.id),
        author,
        base: pull.base.sha,
        requested: (pull.requested_reviewers ?? []).map((u) => u.login),
      };
    },
    async load(token, logins) {
      const asked = logins.filter((l) => LOGIN.test(l) && !isBotLogin(l));
      if (asked.length === 0) return logins.map(() => null);
      // One query for all of them: the logins go in as variables, never into its text.
      const vars = asked.map((_, i) => `$q${i}: String!`).join(", ");
      const fields = asked
        .map((_, i) => `s${i}: search(query: $q${i}, type: ISSUE, first: 1) { issueCount }`)
        .join("\n");
      const variables = Object.fromEntries(
        asked.map((l, i) => [`q${i}`, `is:pr is:open archived:false review-requested:${l}`]),
      );
      const answer = await post(token)<Searched>({
        query: `query(${vars}) {\n${fields}\n}`,
        variables,
      });
      return logins.map((l) => {
        const i = asked.indexOf(l);
        const count = i < 0 ? undefined : answer?.data?.[`s${i}`]?.issueCount;
        return typeof count === "number" ? count : null;
      });
    },
  };
}

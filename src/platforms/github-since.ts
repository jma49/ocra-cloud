import { MAX_CHANGED_FILES, withinBudget } from "./changes.js";
import { type GithubFile, githubHeaders, githubRepoPath, patchedFile } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { compareCall, type PullSince } from "./since.js";

/** GitHub's comparison lists at most this many files. */
const COMPARE_FILES = 300;

type Compare = {
  status: "ahead" | "behind" | "diverged" | "identical";
  files?: GithubFile[];
  total_commits?: number;
};

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      viewerLatestReview { state submittedAt commit { oid } }
    }
  }
}`;

type Answer = {
  data?: {
    repository?: {
      pullRequest?: {
        viewerLatestReview: {
          state: string;
          submittedAt: string | null;
          commit: { oid: string } | null;
        } | null;
      } | null;
    } | null;
  };
};

export function githubSince(host: GithubHost, post: GithubGraphql): PullSince {
  return {
    async diff(token, fullName, since, head) {
      const url = `${host.api}/repos/${githubRepoPath(fullName)}/compare/${since}...${head}`;
      const compare = await compareCall<Compare>(url, githubHeaders(token));
      if (!compare) return null;
      // Behind or diverged: the head no longer contains what was seen.
      if (compare.status === "behind" || compare.status === "diverged") return { state: "rebased" };
      const listed = (compare.files ?? []).slice(0, MAX_CHANGED_FILES);
      return {
        state: "changes",
        commits: typeof compare.total_commits === "number" ? compare.total_commits : null,
        ...withinBudget({
          files: listed.map(patchedFile),
          truncated: listed.length >= COMPARE_FILES,
        }),
      };
    },
    async reviewed(token, fullName, number) {
      const [owner, name] = fullName.split("/");
      const answer = await post(token)<Answer>({
        query: QUERY,
        variables: { owner, name, number },
      });
      const review = answer?.data?.repository?.pullRequest?.viewerLatestReview;
      // A pending review is the user's draft: not yet a review of anything.
      if (!review?.commit || review.state === "PENDING") return null;
      return { head: review.commit.oid, at: review.submittedAt };
    },
  };
}

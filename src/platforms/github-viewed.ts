import type { GithubGraphql } from "./github-host.js";
import type { PullFileViewed } from "./viewed.js";

// GitHub's own viewed state through GraphQL, so a tick here is the one on
// github.com: `viewerViewedState` is DISMISSED once a viewed file changed.

/** Pages of files read: with the diff's own pages, a request stays within Workers' subrequests. */
const MAX_PAGES = 10;
const PER_PAGE = 100;

type ViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";
type FilesPage = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { path: string; viewerViewedState: ViewedState }[];
};
type Files = {
  data?: { repository: { pullRequest: { files: FilesPage | null } | null } | null } | null;
};
type Pull = {
  data?: {
    repository: { pullRequest: { id: string; headRefOid: string } | null } | null;
  } | null;
};
type Mutated = { data?: unknown; errors?: unknown[] };

const FILES = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${PER_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;
const PULL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid } }
}`;

/** One document marking every path, each mutation under its own alias. */
function marking(count: number, viewed: boolean): string {
  const field = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  const params = Array.from({ length: count }, (_, i) => `, $p${i}: String!`).join("");
  const calls = Array.from(
    { length: count },
    (_, i) => `f${i}: ${field}(input: { pullRequestId: $id, path: $p${i} }) { clientMutationId }`,
  );
  return `mutation($id: ID!${params}) {\n  ${calls.join("\n  ")}\n}`;
}

export function githubViewed(post: GithubGraphql): PullFileViewed {
  const where = (fullName: string, number: number) => {
    const [owner, name] = fullName.split("/");
    return { owner, name, number };
  };
  return {
    async list(token, fullName, number) {
      const viewed = new Map<string, boolean>();
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const answer: Files | null = await post(token)<Files>({
          query: FILES,
          variables: { ...where(fullName, number), after },
        });
        const files: FilesPage | null | undefined = answer?.data?.repository?.pullRequest?.files;
        if (!files) return null;
        for (const f of files.nodes) viewed.set(f.path, f.viewerViewedState === "VIEWED");
        if (!files.pageInfo.hasNextPage || !files.pageInfo.endCursor) break;
        after = files.pageInfo.endCursor;
      }
      return viewed;
    },
    async mark(token, fullName, number, mark) {
      const answer = await post(token)<Pull>({
        query: PULL,
        variables: where(fullName, number),
      });
      const pull = answer?.data?.repository?.pullRequest;
      if (!pull) return null;
      if (pull.headRefOid !== mark.head) return "head_moved";
      const paths = Object.fromEntries(mark.paths.map((p, i) => [`p${i}`, p]));
      const sent = await post(token)<Mutated>({
        query: marking(mark.paths.length, mark.viewed),
        variables: { id: pull.id, ...paths },
      });
      if (!sent) return null;
      return sent.errors?.length ? "refused" : "done";
    },
  };
}

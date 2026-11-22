import { type PullNode, pullFragment, pullNodeItem } from "./github-pulls.js";
import type { ListedPull, PullSearch } from "./pulls.js";

// The pull requests a search finds on GitHub, as the user: those they are
// involved in (author, assignee, mentioned, commenter, reviewer) matching
// the words, or the one a reference names.

type Post = <T>(path: string, body: unknown) => Promise<T | null>;
type Found = { data?: { search?: { nodes: (PullNode | null)[] } } };
type Named = { data?: { repository?: { pullRequest?: PullNode | null } | null } | null };

const SEARCH = `query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) { nodes { ...P } }
}
${pullFragment(false)}`;

const NAMED = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...P } }
}
${pullFragment(false)}`;

const listed = (nodes: (PullNode | null)[]) =>
  nodes.filter((n): n is PullNode => Boolean(n?.repository)).map(pullNodeItem);

export async function githubSearch(
  post: Post,
  search: PullSearch,
  limit: number,
): Promise<ListedPull[] | null> {
  if ("text" in search || search.repo === null) {
    const words = "text" in search ? search.text : String(search.number);
    const answer = await post<Found>("/graphql", {
      query: SEARCH,
      variables: { q: `is:pr involves:@me archived:false ${words}`, first: limit },
    });
    const nodes = answer?.data?.search?.nodes;
    if (!nodes) return null;
    const found = listed(nodes);
    return "text" in search ? found : found.filter((p) => p.number === search.number);
  }
  const [owner, name, ...rest] = search.repo.split("/");
  if (!owner || !name || rest.length > 0) return [];
  const answer = await post<Named>("/graphql", {
    query: NAMED,
    variables: { owner, name, number: search.number },
  });
  // A repository or pull request the user cannot see answers data with a null in it.
  if (!answer || answer.data === undefined) return null;
  const pull = answer.data?.repository?.pullRequest;
  return pull ? listed([pull]) : [];
}

import type { PullActionOutcome } from "../shared/index.js";
import { githubHeaders } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformSend } from "./http.js";

type Answer<T> = { data?: T | null; errors?: { type?: string }[] };
type Variables = Record<string, unknown>;

export function githubMergeGraphql(host: GithubHost) {
  const request = <T>(token: string, query: string, variables: Variables) =>
    platformSend<Answer<T>>(host.graphql, {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  return {
    request,
    async mutate(
      token: string,
      mutation: string,
      variables: Variables,
    ): Promise<PullActionOutcome | null> {
      const sent = await request(token, mutation, variables);
      if (!sent || sent.status >= 500) return null;
      // GraphQL can refuse a mutation with HTTP 200 and a FORBIDDEN error.
      const errors = sent.body?.errors ?? [];
      if (sent.status >= 400 || errors.some((e) => e.type === "FORBIDDEN")) return "refused";
      return errors.length > 0 ? "not_mergeable" : "done";
    },
  };
}

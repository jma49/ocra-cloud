/** Where a GitHub is reached: github.com, or a GitHub Enterprise Server. */
export type GithubHost = {
  /** The host its repositories live on, as the CLI writes it. */
  host: string;
  /** Its web address: sign-in, App pages, repositories and their pages. */
  url: string;
  /** The REST API's root, which every path is appended to. */
  api: string;
  graphql: string;
  /**
   * Where its avatars are, which the console's content policy allows: only
   * github.com's, since a server's depends on its subdomain isolation.
   */
  avatars: string | null;
};

export const GITHUB_COM: GithubHost = {
  host: "github.com",
  url: "https://github.com",
  api: "https://api.github.com",
  graphql: "https://api.github.com/graphql",
  avatars: "https://avatars.githubusercontent.com",
};

/** The GitHub at `value`, a web address; github.com's own API when it is github.com. */
export function githubHost(value: string): GithubHost {
  const url = new URL(value);
  if (url.hostname === GITHUB_COM.host) return GITHUB_COM;
  return {
    host: url.host,
    url: url.origin,
    api: `${url.origin}/api/v3`,
    graphql: `${url.origin}/api/graphql`,
    avatars: null,
  };
}

/** A GraphQL call as the user the token is of; null when it failed or was refused. */
export type GithubGraphql = (token: string) => <T>(body: unknown) => Promise<T | null>;

import type { AppBindings } from "../types.js";
import { github } from "./github.js";
import { type GitlabClient, gitlab } from "./gitlab.js";
import type { CodePlatform } from "./platform.js";

type Settings = Pick<
  AppBindings,
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "GITLAB_CLIENT_ID"
  | "GITLAB_CLIENT_SECRET"
  | "GITLAB_URL"
>;

/** This deployment's GitHub App, when it has one: then people also sign in with it. */
export function githubClientOf(env: Settings): { id: string; secret: string } | undefined {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined;
  return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

/** This deployment's GitLab application, when it has one. */
export function gitlabClientOf(env: Settings): GitlabClient | undefined {
  if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) return undefined;
  const url = new URL(env.GITLAB_URL || "https://gitlab.com");
  return { url: url.origin, id: env.GITLAB_CLIENT_ID, secret: env.GITLAB_CLIENT_SECRET };
}

/** Where GitLab sends the user back after they connect it. */
export const gitlabCallback = (requestUrl: string) =>
  new URL("/api/platforms/gitlab/callback", requestUrl).toString();

/** The code platforms this deployment is set up for; `requestUrl` gives its own address. */
export function platformsOf(env: Settings, requestUrl: string): CodePlatform[] {
  const list: CodePlatform[] = [];
  const hub = githubClientOf(env);
  if (hub) list.push(github(hub));
  const lab = gitlabClientOf(env);
  if (lab) list.push(gitlab(lab, gitlabCallback(requestUrl)));
  return list;
}

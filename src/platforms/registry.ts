import type { AppBindings } from "../types.js";
import { github } from "./github.js";
import type { CodePlatform } from "./platform.js";

type Settings = Pick<AppBindings, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">;

/** GitHub through this deployment's App, which is also how people sign in. */
export const githubOf = (env: Settings) =>
  github({ id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET });

/** The code platforms this deployment is set up for, from its settings. */
export function platformsOf(env: Settings): CodePlatform[] {
  return [githubOf(env)];
}

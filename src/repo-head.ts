import type { Context } from "hono";
import type { z } from "zod";
import { apiError } from "./http.js";
import { COMMIT_ID } from "./platforms/contents.js";
import type { CodePlatform } from "./platforms/platform.js";
import { reach } from "./pull-page.js";
import type { repoRef } from "./pull-ref.js";
import type { AppEnv } from "./types.js";

/** A repository the console names: its platform and its path there. */
type RepoRef = z.output<z.ZodObject<typeof repoRef>>;

/** The platform, the token and the repository's default branch head, or the refusal. */
export async function reachRepo(c: Context<AppEnv>, ref: RepoRef) {
  const reached = await reach(c, (p: CodePlatform) => p.kind === ref.platform);
  if ("refusal" in reached) return { refusal: reached.refusal } as const;
  const head = await reached.platform.contents.head(reached.token, ref.repo);
  if (!head || !COMMIT_ID.test(head.commit)) return { refusal: apiError(c, "not_found") } as const;
  return { ...reached, head } as const;
}

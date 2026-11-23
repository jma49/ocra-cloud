import { randomToken, sha256Hex } from "../crypto.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { AutoReviewWebhookView } from "../shared/index.js";
import { type Enrolled, enrollRepo } from "./enroll.js";
import { enrolledGitlabHook, type HookScope } from "./hook-routes.js";

/**
 * Calls one GitLab project's enrollment makes at most: the project and its
 * branch read as the user, then the hooks listed and one added.
 */
export const GITLAB_ENROLL_CALLS = 4;

/**
 * Enrolls one GitLab project as one enrollment does, and adds its hook when
 * it is new to the account; a project enrolled before keeps its hook.
 */
export async function enrollGitlabProject(
  scope: HookScope,
  platform: CodePlatform,
  token: string,
  fullName: string,
  automatic: boolean,
): Promise<Enrolled & { webhook?: AutoReviewWebhookView }> {
  // No secret here: one enrolled before keeps the secret its hook has.
  const enrolled = await enrollRepo(scope.data, platform, token, fullName, { automatic });
  if (enrolled.outcome !== "enrolled") return enrolled;
  // The secret a hook added by hand proves itself with, when ocra cannot add it.
  const secret = randomToken("ocra_hook_");
  await scope.data.update(
    "reviewRepos",
    enrolled.repo.id,
    { webhookSecretHash: await sha256Hex(secret) },
    { webhookSecretHash: null },
  );
  const webhook = await enrolledGitlabHook(scope, enrolled.repo, platform, secret);
  const repo = (await scope.data.get("reviewRepos", enrolled.repo.id)) ?? enrolled.repo;
  return { outcome: "enrolled", repo, webhook };
}

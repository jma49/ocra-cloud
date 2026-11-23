import { audit } from "../audit.js";
import type { Row, Scoped } from "../db/scoped.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { EnrollRefusal } from "../shared/index.js";

/** Repositories one account enrolls at most. */
export const MAX_REVIEW_REPOS = 100;

export type Enrolled =
  | { outcome: "enrolled" | "already"; repo: Row<"reviewRepos"> }
  | { outcome: "refused"; reason: EnrollRefusal };

/**
 * Enrolls one repository for the account: read as the user first, which
 * proves they reach it (on GitHub, through the App), and named by the
 * platform's id, which is what hooks name; then kept in one statement that
 * refuses one another account enrolls, or a new one past the cap. One
 * enrolled before keeps its settings.
 */
export async function enrollRepo(
  data: Scoped,
  platform: CodePlatform,
  token: string,
  fullName: string,
  settings: { automatic: boolean; webhookSecretHash?: string | null },
): Promise<Enrolled> {
  const head = await platform.contents.head(token, fullName);
  if (!head) return { outcome: "refused", reason: "not_found" };
  const where = { platform: platform.kind, host: platform.host };
  const before = await data.findOne("reviewRepos", {
    ...where,
    platformRepoId: head.platformRepoId,
  });
  const id = await data.autoReview.enroll(
    {
      ...where,
      platformRepoId: head.platformRepoId,
      fullName: head.fullName,
      webhookSecretHash: settings.webhookSecretHash ?? null,
      automatic: settings.automatic,
    },
    MAX_REVIEW_REPOS,
  );
  const repo = id ? await data.get("reviewRepos", id) : undefined;
  if (!repo) {
    const full = (await data.count("reviewRepos")) >= MAX_REVIEW_REPOS;
    return { outcome: "refused", reason: full ? "limit" : "taken" };
  }
  if (before) return { outcome: "already", repo };
  await audit(data, "auto_review.enrolled", { repo: repo.fullName, platform: repo.platform });
  return { outcome: "enrolled", repo };
}

import { z } from "zod";
import type { AutoReviewService } from "../auto-review/routes.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { CHECK_NAME } from "../platforms/merge-status.js";

// GitHub's Re-run of the `ocra / pre-merge` check run, or of the App's
// whole check suite: each stored result of that head that was posted is
// opened again and evaluated anew, which updates its check run in place.
// Only the App's own runs are taken, and only runs this repository's rows
// posted; a run that is already being posted again is not opened twice.
// GitLab's commit status has no re-run of its own.

/** Pull requests of one head re-run at once, as a check suite names a head, not a pull request. */
const MAX_RERUNS = 10;

const app = z.object({ id: z.number().int() });

const rerequest = z.object({
  action: z.literal("rerequested"),
  check_run: z
    .object({ id: z.number().int(), name: z.string(), head_sha: z.string(), app })
    .optional(),
  check_suite: z.object({ head_sha: z.string(), app }).optional(),
  repository: z.object({ id: z.number() }),
});

/** The pull requests whose checks a GitHub re-run asked for; how many were opened again. */
export async function rerunGithubChecks(
  db: Db,
  host: string,
  service: AutoReviewService,
  event: string | undefined,
  body: unknown,
): Promise<number> {
  const { checkPull, githubAppId } = service;
  if ((event !== "check_run" && event !== "check_suite") || !checkPull || !githubAppId) return 0;
  const parsed = rerequest.safeParse(body);
  if (!parsed.success) return 0;
  const { check_run: run, check_suite: suite, repository } = parsed.data;
  const target = event === "check_run" ? run : suite;
  if (!target || target.app.id !== Number(githubAppId)) return 0;
  if (event === "check_run" && run?.name !== CHECK_NAME) return 0;
  const head = target.head_sha.toLowerCase();
  if (!COMMIT_ID.test(head)) return 0;
  const repo = await reviewRepoFor(db, "github", host, String(repository.id));
  if (!repo) return 0;
  const data = scoped(db, repo.accountId);
  const where = run && event === "check_run" ? { externalId: String(run.id), head } : { head };
  const rows = await data.find("mergeCheckRuns", { reviewRepoId: repo.id, ...where }, MAX_RERUNS);
  let opened = 0;
  for (const row of rows) {
    if (!(await data.mergeChecks.reopenPost(row.id))) continue;
    checkPull(repo.accountId, repo.id, row.number);
    opened++;
  }
  return opened;
}

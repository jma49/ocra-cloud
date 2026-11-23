import { z } from "zod";
import { callsRefused, withCallLimit } from "../calls.js";
import { autoEnrollFor } from "../db/auto-enroll.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import type { AppBindings } from "../types.js";
import { enrollRepo, MAX_REVIEW_REPOS } from "./enroll.js";

// The repositories added to a GitHub App installation whose switch an
// account turned on (./enroll-routes.ts) are enrolled for that account,
// each read as its user first, as one enrollment is: the App's webhook
// names them, and a step after its answer enrolls them (src/inbound/), a
// few at a time within the calls it may make. What a step leaves stays in
// its work, so the next attempt goes on from there.

/** What the step still has to enroll: the installation, and its added repositories not yet read. */
export type EnrollWork = {
  installationId: string;
  repos: { id: string; fullName: string }[];
};

/**
 * Calls one attempt makes at most: a token refresh and two reads a
 * repository, so ten repositories in a webhook's request, fewer in the
 * hourly sweep's share (src/cron-calls.ts).
 */
const ENROLL_CALLS = 21;

const added = z.object({
  action: z.literal("added"),
  installation: z.object({ id: z.number() }),
  repositories_added: z.array(z.object({ id: z.number(), full_name: z.string().max(200) })),
});

/** The repositories an installation_repositories delivery adds, at most as many as one account enrolls. */
export function githubInstallationAdds(event: string, body: unknown): EnrollWork | null {
  if (event !== "installation_repositories") return null;
  const parsed = added.safeParse(body);
  if (!parsed.success || parsed.data.repositories_added.length === 0) return null;
  return {
    installationId: String(parsed.data.installation.id),
    repos: parsed.data.repositories_added
      .slice(0, MAX_REVIEW_REPOS)
      .map((r) => ({ id: String(r.id), fullName: r.full_name })),
  };
}

/** An attempt that stopped with repositories left, outside a sweep's budget: tried again later. */
class EnrollLeft extends Error {
  override name = "EnrollLeft";
}

/**
 * Enrolls the work's repositories for the account that turned the
 * installation's switch on, taking each from the work as it is done. Where
 * the calls run out, a sweep's attempt is given back with the rest
 * (src/inbound/run.ts); a webhook's throws, so the sweep goes on with it.
 */
export async function enrollAdded(
  runner: { db: Db; env: AppBindings },
  host: string,
  origin: string,
  work: EnrollWork,
): Promise<void> {
  const { db, env } = runner;
  const owner = await autoEnrollFor(db, host, work.installationId);
  const platform = platformsOf(env, origin).find((p) => p.kind === "github" && p.host === host);
  if (!owner || !platform) {
    work.repos = [];
    return;
  }
  const data = scoped(db, owner.accountId);
  await withCallLimit(ENROLL_CALLS, async () => {
    // Enrolled already, by any account: nothing to read.
    const left = [];
    for (const repo of work.repos) {
      if (!(await reviewRepoFor(db, "github", host, repo.id))) left.push(repo);
    }
    work.repos = left;
    if (left.length === 0) return;
    const token = await accessToken(data, env, platform);
    if (!token) {
      // A link that no longer works enrolls nothing until the user signs in again.
      if (!callsRefused()) work.repos = [];
      return;
    }
    while (work.repos[0]) {
      const enrolled = await enrollRepo(data, platform, token, work.repos[0].fullName, {
        automatic: owner.automatic,
      });
      if (callsRefused()) return;
      work.repos.shift();
      if (enrolled.outcome === "refused" && enrolled.reason === "limit") work.repos = [];
    }
  });
  if (work.repos.length > 0 && !callsRefused()) throw new EnrollLeft();
}

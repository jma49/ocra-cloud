import { type CallBudget, callsRefused, item, withCalls } from "../calls.js";
import { claimGroupSweep, type GroupTurn, releaseGroupSweep } from "../db/auto-enroll-groups.js";
import type { Db } from "../db/client.js";
import { reviewRepoFor } from "../db/review-jobs.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { BotTokens } from "../platforms/bot.js";
import { gitlabGroupProjects } from "../platforms/gitlab-group-projects.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { AppBindings } from "../types.js";
import { MAX_REVIEW_REPOS } from "./enroll.js";
import { enrollGitlabProject, GITLAB_ENROLL_CALLS } from "./enroll-gitlab.js";
import { gitlabHookUrl } from "./hook-routes.js";

// The GitLab groups whose switch an account turned on (./group-routes.ts)
// get their new projects enrolled for that account, as one enrollment
// does, each with its hook: GitLab's group hooks are a paid feature and
// its system hooks an admin's, so the hourly run lists each group's newest
// projects once a day (the claim, src/db/auto-enroll-groups.ts), within
// its share of calls (src/cron-calls.ts), and enrolls those above the
// newest it saw. Each project done moves that mark, so a project the
// account unenrolls later is not enrolled again; a run the calls cut short
// gives its claim back and the next goes on from the mark. A project still
// empty (no branch) waits for its first push, a week at most.

export type GroupSweeper = {
  db: Db;
  env: Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">;
  platforms: readonly CodePlatform[];
  bots?: BotTokens | undefined;
  /** The deployment's address, which the hooks point to. */
  origin: string;
};

/** Groups swept per run: 24 runs a day sweep 120 a day. */
const GROUPS_PER_RUN = 5;
/** A group's token (refreshed when it expired) and one page of its projects. */
const FEWEST_CALLS = 2;
/** New projects one sweep of a group reads at most: as many as one account enrolls. */
const PAGE = MAX_REVIEW_REPOS;
/** How long an empty project is waited for before it is passed over. */
const EMPTY_WAIT_MS = 7 * 24 * 60 * 60_000;

type Swept = "done" | "cut" | "skipped";

/** One run's sweep: given more calls after its own ran out, it goes on within the same cap; how many groups it claimed. */
export function sweepGroupsRun(r: GroupSweeper, now = new Date()) {
  let claimed = 0;
  return (calls: CallBudget): Promise<number> =>
    withCalls(calls, async () => {
      while (claimed < GROUPS_PER_RUN && calls.has(FEWEST_CALLS)) {
        const turn = await claimGroupSweep(r.db, now);
        if (!turn) break;
        claimed++;
        try {
          const swept = await item(() => sweepGroup(r, turn, calls, now));
          if (swept.cut || swept.value === "cut") await releaseGroupSweep(r.db, turn);
        } catch (e) {
          logError("group_sweep_failed", { error: errorName(e) });
        }
      }
      return claimed;
    });
}

async function sweepGroup(
  r: GroupSweeper,
  turn: GroupTurn,
  calls: CallBudget,
  now: Date,
): Promise<Swept> {
  const platform = r.platforms.find((p) => p.kind === "gitlab" && p.host === turn.host);
  if (!platform) return "skipped";
  const data = scoped(r.db, turn.accountId);
  const token = await accessToken(data, r.env, platform);
  if (!token) return callsRefused() ? "cut" : "skipped";
  const listed = await gitlabGroupProjects(platform.url, token, turn.groupId, PAGE);
  if (!listed) return callsRefused() ? "cut" : "skipped";
  const scope = { data, bots: r.bots, hookUrl: gitlabHookUrl(r.origin) };
  let mark = turn.lastProjectId;
  const moveTo = async (id: number) => {
    const moved = await data.update(
      "autoEnrollGroups",
      turn.id,
      { lastProjectId: id },
      { lastProjectId: mark },
    );
    if (moved) mark = id;
    return moved;
  };
  // Oldest first, so the mark only ever passes projects done.
  for (const project of listed.filter((p) => p.id > mark).reverse()) {
    if (project.empty) {
      const young =
        !project.createdAt || now.getTime() - project.createdAt.getTime() < EMPTY_WAIT_MS;
      if (young) return "done";
      if (!(await moveTo(project.id))) return "done";
      continue;
    }
    if (!(await reviewRepoFor(r.db, "gitlab", platform.host, String(project.id)))) {
      if (!calls.has(GITLAB_ENROLL_CALLS)) return "cut";
      const enrolled = await enrollGitlabProject(
        scope,
        platform,
        token,
        project.fullName,
        turn.automatic,
      );
      if (callsRefused()) return "cut";
      if (enrolled.outcome === "refused" && enrolled.reason === "limit") {
        // The account is full: the projects made until now are passed over.
        await moveTo(listed[0]?.id ?? project.id);
        return "done";
      }
    }
    // The switch turned off or moved meanwhile: this sweep stops.
    if (!(await moveTo(project.id))) return "done";
  }
  return "done";
}

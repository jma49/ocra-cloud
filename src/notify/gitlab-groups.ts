import { z } from "zod";
import type { PathReader } from "../auto-review/paths.js";
import { teamMembers } from "../auto-review/teams.js";
import { teamReviewerId } from "../db/review-teams.js";
import type { Row, Scoped } from "../db/scoped.js";
import { scoped } from "../db/scoped.js";
import {
  type ApprovalGroup,
  gitlabApprovalGroups,
  gitlabGroupMembers,
} from "../platforms/gitlab-groups.js";
import { accessToken } from "../platforms/links.js";
import { plain } from "./channels.js";
import type { EventRepo, PullEvent } from "./pull-events.js";

// A GitLab merge request asks a group for approval through its approval
// rules, which no hook carries: when it opens, reopens or gains commits, the
// rules are read once after the hook is answered, as the bot or else the
// enrolling account's link. Each group named is kept as the group's ask
// ("team:<id>", as a GitHub team's) and its members are read like a team's
// (src/auto-review/teams.ts); a group no longer named is asked no more.
// No token, a refusal or a timeout changes nothing.

/** What GitLab is asked of a merge request's groups. */
export type GroupAsks = {
  groups(number: number): Promise<ApprovalGroup[] | null>;
  members(groupId: number): Promise<string[] | null>;
};

export function gitlabGroupAsks(
  reader: PathReader,
  repo: Pick<Row<"reviewRepos">, "accountId" | "platform" | "host" | "fullName">,
): GroupAsks {
  const platform = reader.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  let token: Promise<string | null> | undefined;
  const tokenOf = () => {
    token ??= (async () => {
      if (!platform) return null;
      const bot = reader.bots ? await reader.bots.forRepo(repo.platform, repo.fullName) : null;
      return (
        bot?.token ?? (await accessToken(scoped(reader.db, repo.accountId), reader.env, platform))
      );
    })();
    return token;
  };
  return {
    async groups(number) {
      const t = await tokenOf();
      return t && platform ? gitlabApprovalGroups(platform.url, t, repo.fullName, number) : null;
    },
    async members(groupId) {
      const t = await tokenOf();
      return t && platform ? gitlabGroupMembers(platform.url, t, groupId) : null;
    },
  };
}

export const gitlabRulesEvent = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    oldrev: z.string().nullish(),
    title: z.string(),
    author_id: z.number().optional(),
  }),
  user: z.object({ id: z.number() }).optional(),
});

/** Whether the hook may have changed which groups the rules name: opened, reopened or new commits. */
const readsRules = (a: z.infer<typeof gitlabRulesEvent>["object_attributes"]) =>
  a.action === "open" || a.action === "reopen" || (a.action === "update" && !!a.oldrev);

/** Records the merge request's group asks; the review_requested events of their members. */
export async function gitlabGroupEvents(
  data: Scoped,
  repo: EventRepo & { id: string },
  body: unknown,
  asks: GroupAsks,
  now = new Date(),
): Promise<PullEvent[]> {
  const parsed = gitlabRulesEvent.safeParse(body);
  if (!parsed.success || !readsRules(parsed.data.object_attributes)) return [];
  const { object_attributes: a, user } = parsed.data;
  const groups = await asks.groups(a.iid);
  if (!groups) return [];
  const pull = { reviewRepoId: repo.id, number: a.iid };
  const named = new Set(groups.map((g) => teamReviewerId(g.id)));
  for (const reviewerId of await data.reviewRequests.waitingTeams(pull)) {
    if (!named.has(reviewerId)) await data.reviewRequests.done({ ...pull, reviewerId, at: now });
  }
  for (const g of groups) {
    await data.reviewRequests.askedOnce({
      ...pull,
      reviewerId: teamReviewerId(g.id),
      reviewer: g.path,
      at: now,
    });
  }
  // A group whose ask a member's approval ended tells nobody until it is asked anew.
  const waiting = new Set(await data.reviewRequests.waitingTeams(pull));
  const author = a.author_id === undefined ? null : String(a.author_id);
  const events = new Map<string, PullEvent>();
  for (const g of groups) {
    const reviewerId = teamReviewerId(g.id);
    if (!waiting.has(reviewerId)) continue;
    const members = await teamMembers(
      data,
      () => asks.members(g.id),
      { platform: "gitlab", host: repo.host, reviewerId, name: g.path },
      now,
    );
    for (const member of members ?? []) {
      if (member === author) continue;
      // One key per member, whoever was asked: tellGitlabHook adds the round of review.
      const key = `gitlab:requested:${repo.id}#${a.iid}:${member}`;
      if (events.has(key)) continue;
      events.set(key, {
        kind: "review_requested",
        key,
        number: a.iid,
        concerns: member,
        by: user ? String(user.id) : null,
        what: `Approval was asked of ${plain(g.path)}, a group you are on`,
        more: [plain(a.title)],
      });
    }
  }
  return [...events.values()];
}

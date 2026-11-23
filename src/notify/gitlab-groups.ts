import { z } from "zod";
import type { PathReader } from "../auto-review/paths.js";
import { gitlabOpen } from "../auto-review/requests.js";
import { teamMembers } from "../auto-review/teams.js";
import { teamReviewerId } from "../db/review-teams.js";
import type { Row, Scoped } from "../db/scoped.js";
import { scoped } from "../db/scoped.js";
import {
  type ApprovalGroup,
  gitlabApprovalGroups,
  gitlabApprovers,
  gitlabGroupMembers,
} from "../platforms/gitlab-groups.js";
import { accessToken } from "../platforms/links.js";
import type { RepoTokenFields } from "../platforms/repo-token.js";
import { plain } from "./channels.js";
import type { EventRepo, PullEvent } from "./pull-events.js";

// A GitLab merge request asks a group for approval through its approval
// rules, which no hook carries: when it opens, reopens or gains commits, the
// rules are read once after the hook is answered, as the bot or else the
// enrolling account's link. Each group named is kept as the group's ask
// ("team:<id>", as a GitHub team's) and its members are read like a team's
// (src/auto-review/teams.ts); a group no longer named is asked no more.
// An approval ends an ask, and GitLab takes approvals back (a member's own
// removal, or every approval when commits are added): at those hooks, an
// ended ask of a group still named, or of a user still a reviewer, opens
// again once GitLab's list of approvers no longer holds the approval.
// No token, a refusal or a timeout changes nothing.

/** What GitLab is asked of a merge request's groups. */
export type GroupAsks = {
  groups(number: number): Promise<ApprovalGroup[] | null>;
  members(groupId: number): Promise<string[] | null>;
  /** The ids of the users whose approval of the merge request stands. */
  approvers(number: number): Promise<string[] | null>;
};

export function gitlabGroupAsks(
  reader: PathReader,
  repo: Pick<Row<"reviewRepos">, "accountId" | "platform" | "host" | "fullName"> &
    Partial<Pick<Row<"reviewRepos">, RepoTokenFields>>,
): GroupAsks {
  const platform = reader.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  let token: Promise<string | null> | undefined;
  const tokenOf = () => {
    token ??= (async () => {
      if (!platform) return null;
      const bot = reader.bots ? await reader.bots.forRepo(repo) : null;
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
    async approvers(number) {
      const t = await tokenOf();
      return t && platform ? gitlabApprovers(platform.url, t, repo.fullName, number) : null;
    },
  };
}

export const gitlabRulesEvent = z.object({
  object_attributes: z.object({
    iid: z.number().int().min(1),
    action: z.string().optional(),
    state: z.string().optional(),
    oldrev: z.string().nullish(),
    title: z.string(),
    author_id: z.number().optional(),
    reviewer_ids: z.array(z.number()).optional(),
  }),
  user: z.object({ id: z.number() }).optional(),
});

type Attributes = z.infer<typeof gitlabRulesEvent>["object_attributes"];

/** Whether the hook may have taken an approval back: one removed, or new commits. */
const unapproves = (a: Attributes) =>
  a.action === "unapproved" || a.action === "unapproval" || (a.action === "update" && !!a.oldrev);

/** Whether the hook may have changed which groups the rules name, or who of them approved. */
const readsRules = (a: Attributes) => a.action === "open" || a.action === "reopen" || unapproves(a);

/**
 * Opens again the ended asks whose approval GitLab no longer lists: of a
 * reviewer the hook still names, and of a named group none of whose members
 * approves. The approvers are read only when such an ask has ended.
 */
async function reopenUnapproved(
  data: Scoped,
  pull: { reviewRepoId: string; number: number },
  a: Attributes,
  groups: readonly ApprovalGroup[],
  asks: GroupAsks,
  membersOf: (g: ApprovalGroup) => Promise<string[] | null>,
  now: Date,
): Promise<void> {
  const ended = new Set(await data.reviewRequests.ended(pull));
  const reviewers = (a.reviewer_ids ?? []).map(String).filter((id) => ended.has(id));
  const teams = groups.filter((g) => ended.has(teamReviewerId(g.id)));
  if (reviewers.length + teams.length === 0) return;
  const approvers = await asks.approvers(pull.number);
  if (!approvers) return;
  const approved = new Set(approvers);
  for (const reviewerId of reviewers) {
    if (!approved.has(reviewerId))
      await data.reviewRequests.reopened({ ...pull, reviewerId, at: now });
  }
  for (const g of teams) {
    const members = await membersOf(g);
    // A group whose members are unknown may hold the approval: it stays ended.
    if (!members?.length || members.some((m) => approved.has(m))) continue;
    await data.reviewRequests.reopened({ ...pull, reviewerId: teamReviewerId(g.id), at: now });
  }
}

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
  const pull = { reviewRepoId: repo.id, number: a.iid };
  const read = new Map<number, Promise<string[] | null>>();
  const membersOf = (g: ApprovalGroup) => {
    const members =
      read.get(g.id) ??
      teamMembers(
        data,
        () => asks.members(g.id),
        { platform: "gitlab", host: repo.host, reviewerId: teamReviewerId(g.id), name: g.path },
        now,
      );
    read.set(g.id, members);
    return members;
  };
  if (!groups) {
    // The rules refused (GitLab Free has none): a reviewer's approval may still be gone.
    if (unapproves(a) && gitlabOpen(a.state))
      await reopenUnapproved(data, pull, a, [], asks, membersOf, now);
    return [];
  }
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
  if (unapproves(a) && gitlabOpen(a.state))
    await reopenUnapproved(data, pull, a, groups, asks, membersOf, now);
  // A group whose ask a member's approval ended tells nobody until it is asked anew.
  const waiting = new Set(await data.reviewRequests.waitingTeams(pull));
  const author = a.author_id === undefined ? null : String(a.author_id);
  const events = new Map<string, PullEvent>();
  for (const g of groups) {
    const reviewerId = teamReviewerId(g.id);
    if (!waiting.has(reviewerId)) continue;
    const members = await membersOf(g);
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

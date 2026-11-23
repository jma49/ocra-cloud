import type { ReviewerState } from "../shared/index.js";
import { outcomeOf } from "./actions.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import { isBotLogin } from "./reviewers.js";
import { byLogin, type PeopleEdit, type PullRoster, reviewerStates, sameLogin } from "./roster.js";

// GitLab's reviewers and assignees, which it sets by user id and all at
// once: the ones a merge request has are read first and kept. Its people one
// can ask are the project's members, its groups' included, searched by
// GitLab itself.

type User = { id: number; username: string; name?: string; bot?: boolean; state?: string };
type MergeRequest = { author: User | null; reviewers?: User[]; assignees?: User[] };
type Reviewer = { user: User | null; state?: string };

const PER_PAGE = 100;

/** `unreviewed`, `review_started` and `unapproved` are asked and not answered. */
const STATE: Record<string, ReviewerState> = {
  reviewed: "commented",
  requested_changes: "changes_requested",
  approved: "approved",
};

const person = (u: User | null | undefined): u is User =>
  !!u && u.bot !== true && !isBotLogin(u.username);

/** Each login's user id, in order, null for one that is no user; null when GitLab was not reached. */
export async function gitlabUserIds(
  origin: string,
  token: string,
  logins: readonly string[],
): Promise<(number | null)[] | null> {
  const found = await Promise.all(
    logins.map((login) =>
      platformCall<{ id: number }[]>(
        `${origin}/api/v4/users?username=${encodeURIComponent(login)}`,
        { headers: gitlabHeaders(token) },
      ),
    ),
  );
  if (found.some((users) => users === null)) return null;
  return found.map((users) => users?.[0]?.id ?? null);
}

export function gitlabRoster(origin: string): PullRoster {
  const headers = (token: string) => ({ headers: gitlabHeaders(token) });
  const edit = async (
    token: string,
    fullName: string,
    number: number,
    change: PeopleEdit,
    field: "reviewers" | "assignees",
  ) => {
    const url = mergeRequestUrl(origin, fullName, number);
    const [mr, added] = await Promise.all([
      platformCall<MergeRequest>(url, headers(token)),
      gitlabUserIds(origin, token, change.add),
    ]);
    if (!mr || !added) return null;
    if (added.some((id) => id === null)) return "refused";
    const kept = (mr[field] ?? [])
      .filter((u) => !change.remove.some((r) => sameLogin(r, u.username)))
      .map((u) => u.id);
    const ids = [...new Set([...kept, ...added.filter((id) => id !== null)])];
    const key = field === "reviewers" ? "reviewer_ids" : "assignee_ids";
    return outcomeOf(
      await platformSend(url, {
        method: "PUT",
        headers: { ...gitlabHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ [key]: ids }),
      }),
    );
  };
  return {
    async read(token, fullName, number) {
      const url = mergeRequestUrl(origin, fullName, number);
      const [mr, reviewers] = await Promise.all([
        platformCall<MergeRequest>(url, headers(token)),
        platformCall<Reviewer[]>(`${url}/reviewers?per_page=${PER_PAGE}`, headers(token)),
      ]);
      if (!mr || !reviewers) return null;
      const author = person(mr.author) ? mr.author.username : null;
      const listed = reviewers.flatMap((r) => (person(r.user) ? [{ ...r, user: r.user }] : []));
      const answered = listed.flatMap((r) => {
        const state = STATE[r.state ?? ""];
        return state ? [{ login: r.user.username, state }] : [];
      });
      const asked = listed.filter((r) => !STATE[r.state ?? ""]).map((r) => r.user.username);
      return {
        author,
        reviewers: reviewerStates(asked, answered, author),
        teams: [],
        assignees: (mr.assignees ?? []).map((u) => u.username),
        truncated: reviewers.length >= PER_PAGE,
      };
    },
    async candidates(token, fullName, prefix, limit) {
      const query = new URLSearchParams({ per_page: String(PER_PAGE) });
      if (prefix) query.set("query", prefix);
      const members = await platformCall<User[]>(
        `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/members/all?${query}`,
        headers(token),
      );
      if (!members) return null;
      // GitLab matches names too, anywhere in them: only a login's start counts here.
      const matches = members
        .filter((m, i, all) => all.findIndex((o) => o.id === m.id) === i)
        .filter((m) => person(m) && (m.state ?? "active") === "active")
        .filter((m) => m.username.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((m) => ({ login: m.username, name: m.name || null }));
      return {
        candidates: matches.sort(byLogin(prefix)).slice(0, limit),
        truncated: members.length >= PER_PAGE || matches.length > limit,
      };
    },
    editReviewers: (token, fullName, number, change) =>
      edit(token, fullName, number, change, "reviewers"),
    editAssignees: (token, fullName, number, change) =>
      edit(token, fullName, number, change, "assignees"),
  };
}

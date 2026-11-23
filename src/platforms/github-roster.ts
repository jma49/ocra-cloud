import type { ReviewerState } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubHost } from "./github-host.js";
import { platformCall, platformSend } from "./http.js";
import { isBotLogin } from "./reviewers.js";
import { byLogin, type PullRoster, reviewerStates, sameLogin, startsWith } from "./roster.js";

// GitHub's requested reviewers and assignees. Its people one can ask are
// those it lets be assigned (the assignees endpoint, readable with read
// access, unlike the collaborators list), read a page at a time through the
// answer cache, so a search typed letter by letter costs GitHub's 304s.

type User = { login: string; type?: string };
type Pull = {
  user: User | null;
  requested_reviewers?: User[];
  requested_teams?: { slug: string; name: string }[];
  assignees?: User[];
};
type Review = { user: User | null; state: string };

const PER_PAGE = 100;
/** Pages of assignable people one search reads: 500 people. */
const MAX_PAGES = 5;

const STATE: Record<string, ReviewerState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const person = (u: User | null | undefined): u is User =>
  !!u && u.type !== "Bot" && !isBotLogin(u.login);

export function githubRoster(
  host: GithubHost,
  actions: Pick<PullActions, "requestReviewers">,
): PullRoster {
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  const get = <T>(token: string, url: string) =>
    platformCall<T>(url, { headers: githubHeaders(token) });
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend<Pull>(url, {
      method,
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const pull = (token: string, fullName: string, number: number) =>
    get<Pull>(token, `${repo(fullName)}/pulls/${number}`);
  return {
    async read(token, fullName, number) {
      const [found, reviews] = await Promise.all([
        pull(token, fullName, number),
        get<Review[]>(token, `${repo(fullName)}/pulls/${number}/reviews?per_page=${PER_PAGE}`),
      ]);
      if (!found || !reviews) return null;
      const author = person(found.user) ? found.user.login : null;
      const given = reviews.flatMap((r) => {
        const state = STATE[r.state];
        return person(r.user) && state ? [{ login: r.user.login, state }] : [];
      });
      return {
        author,
        reviewers: reviewerStates(
          (found.requested_reviewers ?? []).filter(person).map((u) => u.login),
          given,
          author,
        ),
        teams: (found.requested_teams ?? []).map((t) => ({ slug: t.slug, name: t.name })),
        assignees: (found.assignees ?? []).map((u) => u.login),
        // One page is read: a full one may not be all.
        truncated: reviews.length >= PER_PAGE,
      };
    },
    async candidates(token, fullName, prefix, limit) {
      const matches: { login: string; name: null }[] = [];
      let full = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${repo(fullName)}/assignees?per_page=${PER_PAGE}&page=${page}`;
        const listed = await get<User[]>(token, url);
        if (!listed) return null;
        for (const u of listed) {
          if (person(u) && startsWith(u.login, prefix))
            matches.push({ login: u.login, name: null });
        }
        full = listed.length >= PER_PAGE;
        if (!full || matches.length > limit) break;
      }
      return {
        candidates: matches.sort(byLogin(prefix)).slice(0, limit),
        truncated: full || matches.length > limit,
      };
    },
    async editReviewers(token, fullName, number, edit) {
      if (edit.add.length > 0) {
        const added = await actions.requestReviewers(token, fullName, number, edit.add);
        if (added !== "done") return added;
      }
      if (edit.remove.length === 0) return "done";
      const found = await pull(token, fullName, number);
      if (!found) return null;
      // Only those asked now are removed: a review already given is not taken back.
      const asked = (found.requested_reviewers ?? []).map((u) => u.login);
      const gone = asked.filter((login) => edit.remove.some((r) => sameLogin(r, login)));
      if (gone.length === 0) return "done";
      const url = `${repo(fullName)}/pulls/${number}/requested_reviewers`;
      return outcomeOf(await send(token, "DELETE", url, { reviewers: gone }));
    },
    async editAssignees(token, fullName, number, edit) {
      const url = `${repo(fullName)}/issues/${number}/assignees`;
      if (edit.add.length > 0) {
        const added = await send(token, "POST", url, { assignees: edit.add });
        const outcome = outcomeOf(added);
        if (outcome !== "done") return outcome;
        // GitHub answers 201 and leaves out whom it cannot assign.
        const now = (added?.body?.assignees ?? []).map((u) => u.login);
        if (!edit.add.every((login) => now.some((n) => sameLogin(n, login)))) return "refused";
      }
      if (edit.remove.length === 0) return "done";
      return outcomeOf(await send(token, "DELETE", url, { assignees: edit.remove }));
    },
  };
}

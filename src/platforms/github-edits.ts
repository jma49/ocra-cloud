import { MAX_REPO_LABELS } from "../shared/index.js";
import { outcomeOf, type PullActions } from "./actions.js";
import { forbiddenUnlessLimited, labelColor, type PullEdits, sameLabel } from "./edits.js";
import { githubHeaders, githubRepoPath } from "./github-changes.js";
import type { GithubGraphql, GithubHost } from "./github-host.js";
import { platformCall, platformSend } from "./http.js";

// GitHub's labels through the issues API (a pull request is an issue there),
// its draft state through GraphQL, the only API that changes it, and its
// branch updated by merging the base into it.

type Label = { name: string; color?: string | null; description?: string | null };
type Pull = {
  node_id: string;
  draft?: boolean;
  state: string;
  merged_at: string | null;
  head: { sha: string };
};
type Mutated = { data?: unknown; errors?: unknown[] };

const READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }`;
const TO_DRAFT = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }`;

/** GitHub answers 422 for each reason it does not update a branch, told apart by its message only. */
function refusedUpdate(message: unknown) {
  const text = typeof message === "string" ? message : "";
  if (/expected head sha/i.test(text)) return "head_moved";
  if (/no new commits/i.test(text)) return "up_to_date";
  return "conflicts";
}

const stateOf = (pull: Pull) =>
  pull.state === "open" ? "open" : pull.merged_at ? "merged" : "closed";

export function githubEdits(
  host: GithubHost,
  post: GithubGraphql,
  actions: Pick<PullActions, "addLabels">,
): PullEdits {
  const repo = (fullName: string) => `${host.api}/repos/${githubRepoPath(fullName)}`;
  const get = <T>(token: string, url: string) =>
    platformCall<T>(url, { headers: githubHeaders(token) });
  const applied = async (token: string, fullName: string, number: number) => {
    const url = `${repo(fullName)}/issues/${number}/labels?per_page=${MAX_REPO_LABELS}`;
    const labels = await get<Label[]>(token, url);
    return labels?.map((l) => l.name) ?? null;
  };
  const pull = (token: string, fullName: string, number: number) =>
    get<Pull>(token, `${repo(fullName)}/pulls/${number}`);
  return {
    async labels(token, fullName, number) {
      const [on, all] = await Promise.all([
        applied(token, fullName, number),
        get<Label[]>(token, `${repo(fullName)}/labels?per_page=${MAX_REPO_LABELS}`),
      ]);
      if (!on || !all) return null;
      return {
        applied: on,
        available: all.map((l) => ({
          name: l.name,
          color: labelColor(l.color),
          description: l.description || null,
        })),
        // One page is read: a full one may not be all.
        truncated: all.length >= MAX_REPO_LABELS,
      };
    },
    async editLabels(token, fullName, number, edit) {
      const on = edit.remove.length > 0 ? await applied(token, fullName, number) : [];
      if (!on) return null;
      if (edit.add.length > 0) {
        const added = await actions.addLabels(token, fullName, number, edit.add);
        if (added !== "done") return added;
      }
      // Only labels it has are removed: GitHub's 404 for one it lacks reads as any other.
      const gone = on.filter((name) => edit.remove.some((r) => sameLabel(r, name)));
      for (const name of gone) {
        const url = `${repo(fullName)}/issues/${number}/labels/${encodeURIComponent(name)}`;
        const removed = outcomeOf(
          await platformSend(url, { method: "DELETE", headers: githubHeaders(token) }),
        );
        if (removed !== "done") return removed;
      }
      return "done";
    },
    async draft(token, fullName, number) {
      const found = await pull(token, fullName, number);
      return found && { draft: found.draft === true, state: stateOf(found) };
    },
    async setDraft(token, fullName, number, draft) {
      const found = await pull(token, fullName, number);
      if (!found) return null;
      if (stateOf(found) !== "open") return "refused";
      if ((found.draft === true) === draft) return "done";
      const answer = await post(token)<Mutated>({
        query: draft ? TO_DRAFT : READY,
        variables: { id: found.node_id },
      });
      if (!answer) return null;
      return answer.errors?.length ? "refused" : "done";
    },
    async updateBranch(token, fullName, number, head) {
      const found = await pull(token, fullName, number);
      if (!found) return null;
      if (stateOf(found) !== "open") return "not_open";
      if (found.head.sha !== head) return "head_moved";
      const sent = await platformSend<{ message?: unknown }>(
        `${repo(fullName)}/pulls/${number}/update-branch`,
        {
          method: "PUT",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          // GitHub refuses the update itself when the head moved after it was read.
          body: JSON.stringify({ expected_head_sha: head }),
        },
      );
      if (!sent) return null;
      if (sent.status === 202 || sent.status === 200) return "updating";
      if (sent.status === 422) return refusedUpdate(sent.body?.message);
      if (sent.status === 403 || sent.status === 404) return forbiddenUnlessLimited();
      return null;
    },
  };
}

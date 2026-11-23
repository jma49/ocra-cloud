import { MAX_REPO_LABELS, type PullState } from "../shared/index.js";
import { outcomeOf } from "./actions.js";
import { forbiddenUnlessLimited, labelColor, type PullEdits } from "./edits.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";

// GitLab's merge request labels, added and removed in one update, its
// draft state, which GitLab reads from the title's prefix: its API has no
// other way to set it, and its branch rebased on the target.

type Label = { name: string; color?: string | null; description?: string | null };
type MergeRequest = { title: string; state: string; draft?: boolean; labels?: string[] };
type Diverged = {
  state: string;
  sha: string;
  has_conflicts?: boolean;
  diverged_commits_count?: number;
  rebase_in_progress?: boolean;
};

/** The prefixes GitLab reads as a draft, any number of them, in any case. */
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i;

function stripDraft(title: string): string {
  let rest = title;
  while (DRAFT_PREFIX.test(rest)) rest = rest.replace(DRAFT_PREFIX, "");
  return rest;
}

const STATE: Record<string, PullState> = { opened: "open", merged: "merged" };

export function gitlabEdits(origin: string): PullEdits {
  const read = (token: string, fullName: string, number: number) =>
    platformCall<MergeRequest>(mergeRequestUrl(origin, fullName, number), {
      headers: gitlabHeaders(token),
    });
  const update = async (token: string, fullName: string, number: number, body: unknown) =>
    outcomeOf(
      await platformSend(mergeRequestUrl(origin, fullName, number), {
        method: "PUT",
        headers: { ...gitlabHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return {
    async labels(token, fullName, number) {
      const project = `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
      const [mr, all] = await Promise.all([
        read(token, fullName, number),
        platformCall<Label[]>(`${project}/labels?per_page=${MAX_REPO_LABELS}`, {
          headers: gitlabHeaders(token),
        }),
      ]);
      if (!mr || !all) return null;
      return {
        applied: mr.labels ?? [],
        available: all.map((l) => ({
          name: l.name,
          color: labelColor(l.color),
          description: l.description || null,
        })),
        truncated: all.length >= MAX_REPO_LABELS,
      };
    },
    editLabels(token, fullName, number, edit) {
      // One update adds and removes together; a label it lacks is not an error to GitLab.
      return update(token, fullName, number, {
        ...(edit.add.length > 0 ? { add_labels: edit.add.join(",") } : {}),
        ...(edit.remove.length > 0 ? { remove_labels: edit.remove.join(",") } : {}),
      });
    },
    async draft(token, fullName, number) {
      const mr = await read(token, fullName, number);
      return mr && { draft: mr.draft === true, state: STATE[mr.state] ?? "closed" };
    },
    async setDraft(token, fullName, number, draft) {
      const mr = await read(token, fullName, number);
      if (!mr) return null;
      if (mr.state !== "opened") return "refused";
      if ((mr.draft === true) === draft) return "done";
      const title = stripDraft(mr.title);
      return update(token, fullName, number, { title: draft ? `Draft: ${title}` : title });
    },
    async updateBranch(token, fullName, number, head) {
      const url = mergeRequestUrl(origin, fullName, number);
      const headers = gitlabHeaders(token);
      const mr = await platformCall<Diverged>(`${url}?include_diverged_commits_count=true`, {
        headers,
      });
      if (!mr) return null;
      if (mr.state !== "opened") return "not_open";
      // GitLab's rebase takes no head to compare: the head is read just before.
      if (mr.sha !== head) return "head_moved";
      if (mr.rebase_in_progress) return "updating";
      if (mr.diverged_commits_count === 0) return "up_to_date";
      // A rebase with conflicts is taken, then fails out of sight: it is not sent.
      if (mr.has_conflicts) return "conflicts";
      const sent = await platformSend(`${url}/rebase`, { method: "PUT", headers });
      if (!sent) return null;
      if (sent.status === 202 || sent.status === 200) return "updating";
      if (sent.status === 403 || sent.status === 404) return forbiddenUnlessLimited();
      return null;
    },
  };
}

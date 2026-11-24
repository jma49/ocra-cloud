import { MAX_CHANGED_FILES, withinBudget } from "./changes.js";
import { type GitlabDiff, gitlabHeaders, mergeRequestUrl, patchedDiff } from "./gitlab-changes.js";
import { platformCall } from "./http.js";
import { compareCall, type PullSince, type SinceDiff } from "./since.js";

/** The newest notes read for the user's own, and the newest diff versions. */
const PER_PAGE = 100;

type Compare = { diffs?: GitlabDiff[]; compare_timeout?: boolean };
type Note = {
  author: { id: number } | null;
  system: boolean;
  body: string;
  created_at: string;
  position?: { head_sha?: string | null } | null;
};
type Version = { head_commit_sha: string; created_at: string };

/**
 * Whether a note is the user's review: a comment or an approval, not a
 * system note their own push left.
 */
const isReview = (n: Note) => !n.system || n.body.startsWith("approved this merge request");

/** The diff from one commit's tree straight to another's, whatever their history. */
export async function straightDiff(
  origin: string,
  token: string,
  fullName: string,
  from: string,
  to: string,
): Promise<SinceDiff | null> {
  const compare = await compareCall<Compare>(
    `${repositoryUrl(origin, fullName)}/compare?from=${from}&to=${to}&straight=true`,
    gitlabHeaders(token),
  );
  if (!compare) return null;
  const diffs = compare.diffs ?? [];
  const files = await Promise.all(diffs.slice(0, MAX_CHANGED_FILES).map((d) => patchedDiff(d, to)));
  const truncated = compare.compare_timeout === true || diffs.length > MAX_CHANGED_FILES;
  return { state: "changes", ...withinBudget({ files, truncated }) };
}

const repositoryUrl = (origin: string, fullName: string) =>
  `${origin}/api/v4/projects/${encodeURIComponent(fullName)}/repository`;

export function gitlabSince(origin: string): PullSince {
  const project = (fullName: string) => repositoryUrl(origin, fullName);
  const get = <T>(token: string, url: string) =>
    platformCall<T>(url, { headers: gitlabHeaders(token) });
  return {
    async diff(token, fullName, since, head) {
      const repo = project(fullName);
      const base = await get<{ id: string }>(
        token,
        `${repo}/merge_base?refs[]=${since}&refs[]=${head}`,
      );
      if (!base) return null;
      if (base.id !== since) return { state: "rebased" };
      return straightDiff(origin, token, fullName, since, head);
    },
    async reviewed(token, fullName, number) {
      const mr = mergeRequestUrl(origin, fullName, number);
      const [me, notes] = await Promise.all([
        get<{ id: number }>(token, `${origin}/api/v4/user`),
        get<Note[]>(token, `${mr}/notes?sort=desc&order_by=created_at&per_page=${PER_PAGE}`),
      ]);
      const note = me && notes?.find((n) => n.author?.id === me.id && isReview(n));
      if (!note) return null;
      const at = note.created_at;
      if (note.position?.head_sha) return { head: note.position.head_sha, at };
      // GitLab records no head on a comment or an approval: the version the
      // merge request was at then is the newest made before it.
      const versions = await get<Version[]>(token, `${mr}/versions?per_page=${PER_PAGE}`);
      const then = versions?.find((v) => Date.parse(v.created_at) <= Date.parse(at));
      return then ? { head: then.head_commit_sha, at } : null;
    },
  };
}

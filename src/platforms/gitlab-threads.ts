import { outcomeOf } from "./actions.js";
import { type DiffRefs, gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import {
  actionOf,
  applicableOf,
  findingsOfSuggestions,
  findingsOfThread,
  MAX_THREAD_COMMENTS,
  MAX_THREADS,
  type PullThreads,
  type Thread,
} from "./threads.js";

// GitLab's diff discussions. GitLab reads a note's suggestions itself and
// says which it can apply (not applied, its lines unchanged on the latest
// diff); they are applied through its suggestion API, which commits them
// together as the user and refuses one whose lines changed since.

const PER_PAGE = 100;
/** Pages of discussions read: each push or label change is one, and the diff's are among them. */
const MAX_PAGES = 10;

type Position = {
  head_sha: string;
  new_path: string | null;
  old_path: string | null;
  new_line: number | null;
  old_line: number | null;
  line_range?: { start?: { new_line?: number | null; old_line?: number | null } } | null;
};
type Note = {
  id: number;
  type: string | null;
  body: string;
  author?: { username: string } | null;
  created_at?: string | null;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  position?: Position | null;
  suggestions?: {
    id: number;
    from_line: number;
    to_line: number;
    appliable: boolean;
    applied: boolean;
    to_content: string;
  }[];
};
type Discussion = { id: string; notes: Note[] };
type MergeRequest = { sha: string; diff_refs: DiffRefs | null };

function threadOf(d: Discussion, root: Note & { position: Position }, head: string): Thread {
  const p = root.position;
  const outdated = p.head_sha !== head;
  const side = p.new_line !== null ? "new" : "old";
  const line = side === "new" ? p.new_line : p.old_line;
  const start = side === "new" ? p.line_range?.start?.new_line : p.line_range?.start?.old_line;
  const resolved = root.resolved === true;
  return {
    id: d.id,
    path: p.new_path ?? p.old_path ?? "",
    line: outdated ? null : line,
    startLine: outdated || !start || start === line ? null : start,
    side,
    resolved,
    outdated,
    canResolve: root.resolvable,
    comments: d.notes
      .filter((n) => !n.system)
      .slice(0, MAX_THREAD_COMMENTS)
      .map((n) => ({
        id: String(n.id),
        author: n.author?.username ?? null,
        body: n.body,
        createdAt: n.created_at ?? null,
        suggestions: (n.suggestions ?? []).map((s) => ({
          id: String(s.id),
          startLine: s.from_line,
          endLine: s.to_line,
          replacement: s.to_content.replace(/\n$/, ""),
          applicable: s.appliable && !s.applied && !outdated,
          applied: s.applied,
        })),
      })),
  };
}

export function gitlabThreads(origin: string): PullThreads {
  const send = (token: string, url: string, body: unknown) =>
    platformSend(url, {
      method: "PUT",
      headers: { ...gitlabHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async (token: string, fullName: string, number: number) => {
    const headers = { headers: gitlabHeaders(token) };
    const url = mergeRequestUrl(origin, fullName, number);
    const mr = await platformCall<MergeRequest>(url, headers);
    if (!mr) return null;
    const head = mr.diff_refs?.head_sha ?? mr.sha;
    const threads: Thread[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        truncated = true;
        break;
      }
      const found = await platformCall<Discussion[]>(
        `${url}/discussions?per_page=${PER_PAGE}&page=${page}`,
        headers,
      );
      if (!found) return null;
      for (const d of found) {
        const root = d.notes[0];
        if (root?.type !== "DiffNote" || !root.position) continue;
        if (threads.length === MAX_THREADS) {
          truncated = true;
          break;
        }
        const thread = threadOf(d, { ...root, position: root.position }, head);
        truncated ||= d.notes.filter((n) => !n.system).length > MAX_THREAD_COMMENTS;
        threads.push(thread);
      }
      if (truncated || found.length < PER_PAGE) break;
    }
    return { head: mr.sha, threads, truncated };
  };
  return {
    list: read,
    async apply(token, fullName, number, apply) {
      const listing = await read(token, fullName, number);
      if (!listing) return null;
      if (listing.head !== apply.head) return actionOf("head_moved");
      const picked = applicableOf(listing.threads, apply.ids);
      if (!picked) return actionOf("not_applicable");
      const ids = picked.map((s) => Number(s.id));
      const [one] = ids;
      // GitLab answers 400 for a suggestion it cannot apply, such as one whose lines changed.
      const special = { 400: "not_applicable" } as const;
      const api = `${origin}/api/v4/suggestions`;
      const sent =
        ids.length === 1 && one !== undefined
          ? await send(token, `${api}/${one}/apply`, {})
          : await send(token, `${api}/batch_apply`, { ids });
      return actionOf(outcomeOf(sent, special), findingsOfSuggestions(listing.threads, apply.ids));
    },
    async resolve(token, fullName, number, thread, resolved) {
      const url = mergeRequestUrl(origin, fullName, number);
      const sent = await send(token, `${url}/discussions/${encodeURIComponent(thread)}`, {
        resolved,
      });
      // GitLab answers the discussion it changed, with its notes.
      const notes = (sent?.body as Partial<Discussion> | null)?.notes;
      const comments = Array.isArray(notes)
        ? notes.filter((n) => !n?.system && typeof n?.body === "string")
        : [];
      return actionOf(outcomeOf(sent), findingsOfThread({ comments }));
    },
  };
}

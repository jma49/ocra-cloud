import type {
  LineSide,
  PullFilesView,
  PullFindingView,
  ReviewThreadView,
} from "../../../src/shared/index.js";
import { anchorOf, parsePatch } from "./diff.js";
import { readComment } from "./thread-body.js";
import type { SearchFocus } from "./use-diff-search.js";

// Every conversation on a pull request's diff, for the column beside it: the
// platform's review threads, ocra's own comments among them, and ocra's open
// findings that were not posted as a thread. Each is open, outdated (its
// lines changed since it was written) or resolved.

export type ConversationState = "open" | "outdated" | "resolved";

export type ConversationItem = {
  id: string;
  path: string;
  /** The line it is on, on `side`; null for one outdated or about the whole file. */
  line: number | null;
  side: LineSide;
  state: ConversationState;
  /** Who started it; null for ocra's finding on the diff. */
  author: string | null;
  ocra: boolean;
  /** Its first line: a finding's title, or the opening comment's text. */
  title: string;
  comments: number;
};

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

function threadItem(t: ReviewThreadView): ConversationItem {
  const said = t.comments[0] ? readComment(t.comments[0].body) : null;
  return {
    id: `thread:${t.id}`,
    path: t.path,
    line: t.line,
    side: t.side,
    state: t.resolved ? "resolved" : t.outdated ? "outdated" : "open",
    author: t.comments[0]?.author ?? null,
    ocra: Boolean(said?.head),
    title: said?.head?.title ?? firstLine(said?.text ?? ""),
    comments: t.comments.length,
  };
}

/** The platform's threads and ocra's findings, by file and line, a finding ocra posted as a thread once. */
export function conversationOf(
  threads: readonly ReviewThreadView[],
  findings: readonly PullFindingView[],
): ConversationItem[] {
  const items = threads.map(threadItem);
  const posted = new Set(items.filter((i) => i.ocra).map((i) => `${i.path}\n${i.title}`));
  for (const f of findings) {
    if (posted.has(`${f.file}\n${f.title}`)) continue;
    items.push({
      id: `finding:${f.id}`,
      path: f.file,
      line: f.lineEnd ?? f.lineStart,
      side: "new",
      state: "open",
      author: null,
      ocra: true,
      title: f.title,
      comments: 1,
    });
  }
  return items.sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.line ?? -1) - (b.line ?? -1),
  );
}

export type ConversationGroups = Record<ConversationState, ConversationItem[]>;

export function groupConversation(items: readonly ConversationItem[]): ConversationGroups {
  const groups: ConversationGroups = { open: [], outdated: [], resolved: [] };
  for (const i of items) groups[i.state].push(i);
  return groups;
}

/** Per file, its comments counted and the first conversation on it. */
export function commentsByFile(items: readonly ConversationItem[]) {
  const out = new Map<string, { count: number; first: ConversationItem }>();
  for (const i of items) {
    const had = out.get(i.path);
    out.set(i.path, { count: (had?.count ?? 0) + i.comments, first: had?.first ?? i });
  }
  return out;
}

type File = PullFilesView["files"][number];

/**
 * Where the diff goes for a conversation: its line, by index in the file's
 * patch, as a find's match is shown; null when its line is not in the diff
 * (outdated, about the whole file, or left out), so only the file is.
 */
export function jumpOf(
  files: readonly File[],
  item: ConversationItem,
  step: number,
): SearchFocus | null {
  const patch = files.find((f) => f.path === item.path)?.patch;
  if (!patch || item.line === null) return null;
  const at = parsePatch(patch).findIndex((l) => {
    const a = anchorOf(l);
    return a?.line === item.line && a.side === item.side;
  });
  return at < 0 ? null : { path: item.path, line: at, from: 0, to: 0, step };
}

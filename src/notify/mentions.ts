import { plain } from "./channels.js";

// What a comment says to the people it names, read without a model: the
// logins it @-mentions in its own prose, and a short excerpt of that prose.
// Code (fenced blocks and inline spans) and quoted lines are not its prose,
// so a mention there names nobody. Only the start of a long comment is read.

/** The characters of a comment read; a mention after them names nobody. */
export const MAX_COMMENT = 16_000;
/** Logins read from one comment. */
const MAX_MENTIONS = 50;
const MAX_EXCERPT = 100;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>/;
// Not part of an address (me@host), a path or a longer name; GitHub's
// @org/team names a team, not the user org.
const MENTION = /(?<![\w.@/`-])@([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?![\w/-])/g;

/** The comment's lines outside fenced code and quotes. */
function proseLines(body: string): string[] {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.slice(0, MAX_COMMENT).split(/\r?\n/)) {
    const open = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (
        open &&
        open[0] === fence[0] &&
        open.length >= fence.length &&
        !line.trim().slice(open.length).trim()
      ) {
        fence = null;
      }
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    if (!QUOTE.test(line)) kept.push(line);
  }
  return kept;
}

/** The text with each inline code span (a run of backticks up to the next run as long) blanked. */
function withoutCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const byLength = new Map<number, number[]>();
  runs.forEach((r, i) => {
    const list = byLength.get(r.len) ?? [];
    list.push(i);
    byLength.set(r.len, list);
  });
  const next = new Map<number, number>();
  let out = "";
  let from = 0;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i] as { at: number; len: number };
    if (open.at < from) continue;
    const list = byLength.get(open.len) as number[];
    let k = next.get(open.len) ?? 0;
    while (k < list.length && (list[k] as number) <= i) k++;
    next.set(open.len, k);
    const close = k < list.length ? runs[list[k] as number] : undefined;
    if (!close) continue;
    out += `${text.slice(from, open.at)} `;
    from = close.at + close.len;
  }
  return out + text.slice(from);
}

const prose = (body: string) => withoutCodeSpans(proseLines(body).join("\n"));

/** The logins the comment @-mentions, lowercased, each once. */
export function mentionsOf(body: string): string[] {
  const found = new Set<string>();
  for (const m of prose(body).matchAll(MENTION)) {
    found.add((m[1] as string).toLowerCase());
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

/** A short excerpt of the comment's prose, made plain; empty when it has none. */
export function excerptOf(body: string): string {
  const text = plain(prose(body));
  const chars = [...text];
  return chars.length > MAX_EXCERPT ? `${chars.slice(0, MAX_EXCERPT - 1).join("")}…` : text;
}

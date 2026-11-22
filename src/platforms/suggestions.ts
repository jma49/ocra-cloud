// Review suggestions as each platform writes them in a comment's Markdown:
// GitHub's ```suggestion block replaces the lines the comment is on, GitLab's
// ```suggestion:-N+M the comment's line with N lines above and M below.

/** A suggestion's text, bounded so its comment stays within a platform's comment. */
export const MAX_SUGGESTION_CHARS = 16_384;
export const MAX_SUGGESTION_LINES = 200;
/** Lines a range comment spans above its last line; GitLab takes at most 100. */
export const MAX_SUGGESTION_RANGE = 100;

type Dialect = "github" | "gitlab";

const lf = (text: string) => text.replace(/\r\n?/g, "\n");

/** The suggestion's text without the one newline a block's last line ends with. */
const linesOf = (suggestion: string) => lf(suggestion).replace(/\n$/, "");

export const suggestionLineCount = (suggestion: string) =>
  suggestion === "" ? 0 : linesOf(suggestion).split("\n").length;

/**
 * The comment's body with the suggestion's block after it. `above` is how many
 * lines over the comment's line the suggestion starts (a range's start).
 */
export function withSuggestion(
  dialect: Dialect,
  body: string,
  suggestion: string,
  above: number,
): string {
  const text = linesOf(suggestion);
  // A fence longer than any the suggestion holds, so its own code cannot close it.
  const runs = [...text.matchAll(/^ {0,3}(`{3,})/gm)].map((m) => m[1]?.length ?? 0);
  const fence = "`".repeat(Math.max(3, ...runs.map((n) => n + 1)));
  const info = dialect === "gitlab" && above > 0 ? `suggestion:-${above}+0` : "suggestion";
  const block = text === "" ? `${fence}${info}\n${fence}` : `${fence}${info}\n${text}\n${fence}`;
  const note = lf(body).trim();
  return note ? `${note}\n\n${block}` : block;
}

const OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*suggestion[ \t]*$/;

/** The replacements of each GitHub suggestion block in a comment, in order; unclosed blocks are not read. */
export function githubSuggestions(body: string): string[] {
  const lines = lf(body).split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i] ?? "");
    if (!open) continue;
    const indent = open[1]?.length ?? 0;
    const fence = open[2] ?? "```";
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const end = lines.findIndex((line, j) => j > i && close.test(line));
    if (end < 0) break;
    found.push(
      lines
        .slice(i + 1, end)
        .map((line) => line.replace(new RegExp(`^ {0,${indent}}`), ""))
        .join("\n"),
    );
    i = end;
  }
  return found;
}

/**
 * The last `count` lines of a diff hunk's new side: the lines a GitHub comment
 * ending on the hunk's last line was written on. undefined when it has fewer.
 */
export function newSideTail(hunk: string, count: number): string[] | undefined {
  const side = lf(hunk)
    .split("\n")
    .filter((line) => line.startsWith(" ") || line.startsWith("+"))
    .map((line) => line.slice(1));
  return count >= 1 && side.length >= count ? side.slice(-count) : undefined;
}

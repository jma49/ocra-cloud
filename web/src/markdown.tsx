import type { ReactNode } from "react";

// Model output about untrusted code, drawn from elements made here only:
// paragraphs, headings, lists, tables, code and emphasis. Links, images and
// HTML stay the text they were written as, so an answer cannot point the
// reader anywhere or load anything. That is why this is not a Markdown
// library. Text a person wrote on the platform (a pull request's
// description) may ask for its links: those open the https address written,
// in a new tab, as the platform's own page would.

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  (ROW.exec(line)?.[1] ?? "").split(/(?<!\\)\|/).map((cell) => cell.trim());

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      // An answer still streaming may not have closed its fence yet.
      for (i++; i < lines.length && !FENCE.test(lines[i] ?? ""); i++) code.push(lines[i] ?? "");
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (ROW.test(line) && RULE.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i] ?? ""); i++)
        rows.push(cells(lines[i] ?? ""));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (heading) {
      flush();
      out.push({ kind: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
    } else if (item) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const last = out.at(-1);
      if (last && last.kind === kind && "items" in last) last.items.push(item[1] ?? "");
      else out.push({ kind, items: [item[1] ?? ""] });
    } else if (line.trim() === "") {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

// Code and a link keep their own `_` and `*`: emphasis runs around them, not into them.
const A_CODE = "`[^`\\n]+`";
const A_LINK = "\\[[^\\]\\n]+\\]\\([^)\\s]+\\)";
const within = (mark: string) => `(?:${A_CODE}|${A_LINK}|[^${mark}\\n])+`;
const INLINE = new RegExp(
  `(${A_CODE}|(?<!!)${A_LINK}|\\*\\*(?!\\s)[^*\\n]+(?<!\\s)\\*\\*` +
    `|(?<![\\w*])\\*(?!\\s)${within("*")}(?<!\\s)\\*(?![\\w*])` +
    `|(?<![\\w_])_(?!\\s)${within("_")}(?<!\\s)_(?![\\w_]))`,
);
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/** The address a link opens: https only, as `URL` reads it, never what was written. */
function httpsAddress(written: string): string | null {
  if (!URL.canParse(written)) return null;
  const url = new URL(written);
  return url.protocol === "https:" ? url.href : null;
}

function inline(text: string, links: boolean): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${i}:${part}`;
    if (i % 2 === 0) return part;
    if (part.startsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    const link = LINK.exec(part);
    if (link) {
      const href = links ? httpsAddress(link[2] ?? "") : null;
      if (href === null) return part;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {inline(link[1] ?? "", false)}
        </a>
      );
    }
    if (part.startsWith("**")) return <strong key={key}>{inline(part.slice(2, -2), links)}</strong>;
    return <em key={key}>{inline(part.slice(1, -1), links)}</em>;
  });
}

/** A document's headings start under the page's own: `#` is an h3, and the smallest an h6. */
const HEADINGS = ["h3", "h4", "h5", "h6"] as const;

export function Markdown(props: {
  text: string;
  /** Only for text a person wrote on the platform: its https links open. */
  links?: boolean;
}) {
  const say = (text: string) => inline(text, props.links === true);
  return (
    <div className="md">
      {blocks(props.text).map((b, i) => {
        const key = `${i}:${b.kind}`;
        if (b.kind === "code")
          return (
            <pre key={key}>
              <code>{b.text}</code>
            </pre>
          );
        if (b.kind === "h") {
          const H = HEADINGS[Math.min(b.level, HEADINGS.length) - 1] ?? "h6";
          return <H key={key}>{say(b.text)}</H>;
        }
        if (b.kind === "p") return <p key={key}>{say(b.text)}</p>;
        if (b.kind === "table")
          return (
            <div key={key} className="md-table">
              <table>
                <thead>
                  <tr>
                    {b.head.map((cell, n) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a table's cells have no identity but their place
                      <th key={n}>{say(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a table's rows have no identity but their place
                    <tr key={r}>
                      {b.head.map((_, n) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a table's cells have no identity but their place
                        <td key={n}>{say(row[n] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        const List = b.kind;
        return (
          <List key={key}>
            {b.items.map((item, n) => {
              const at = `${n}:${item}`;
              return <li key={at}>{say(item)}</li>;
            })}
          </List>
        );
      })}
    </div>
  );
}

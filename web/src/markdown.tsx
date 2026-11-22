import type { ReactNode } from "react";

// Model output about untrusted code, drawn from elements made here only:
// paragraphs, headings, lists, code and emphasis. Links, images and HTML
// stay the text they were written as, so an answer cannot point the reader
// anywhere or load anything. That is why this is not a Markdown library.

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
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
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (heading) {
      flush();
      out.push({ kind: "h", text: heading[1] ?? "" });
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

const INLINE =
  /(`[^`\n]+`|\*\*(?!\s)[^*\n]+(?<!\s)\*\*|(?<![\w*])\*(?!\s)[^*\n]+(?<!\s)\*(?![\w*]))/;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${i}:${part}`;
    if (i % 2 === 0) return part;
    if (part.startsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    return <em key={key}>{part.slice(1, -1)}</em>;
  });
}

export function Markdown(props: { text: string }) {
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
        if (b.kind === "h") return <h4 key={key}>{inline(b.text)}</h4>;
        if (b.kind === "p") return <p key={key}>{inline(b.text)}</p>;
        const List = b.kind;
        return (
          <List key={key}>
            {b.items.map((item, n) => {
              const at = `${n}:${item}`;
              return <li key={at}>{inline(item)}</li>;
            })}
          </List>
        );
      })}
    </div>
  );
}

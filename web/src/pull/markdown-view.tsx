import { useEffect, useState } from "react";
import type { PullLinesView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { PlatformMarkdown } from "../platform-markdown.js";
import type { ContextSource } from "./context-lines.js";

// A Markdown file of a pull request drawn as its readers will see it: the
// whole file at the head shown, read as the user, through the same allowlist
// as a description (the file is the reviewed tree's, so it is untrusted).

const MARKDOWN = /\.(md|markdown)$/i;

export const isMarkdown = (path: string) => MARKDOWN.test(path);

/** Lines one read asks for: the most the lines route answers. */
const CHUNK = 1000;
/** Past this a file is read in its diff only: a page that long is not read as a page here. */
const MAX_LINES = 5 * CHUNK;

type FileText =
  | { kind: "reading" }
  | { kind: "read"; text: string }
  | { kind: "unreadable" }
  | { kind: "long" }
  | { kind: "failed" };

/** The file's text at the head, read in chunks of the route's size. */
function useFileText(source: ContextSource, path: string): FileText {
  const [state, setState] = useState<FileText>({ kind: "reading" });
  const { pull, head } = source;
  useEffect(() => {
    let live = true;
    setState({ kind: "reading" });
    const read = (from: number) =>
      api<PullLinesView>(
        `/pulls/lines?${new URLSearchParams({
          platform: pull.platform,
          repo: pull.repo,
          number: String(pull.number),
          head,
          path,
          from: String(from),
          to: String(from + CHUNK - 1),
        })}`,
      );
    (async (): Promise<FileText> => {
      const lines: string[] = [];
      for (let from = 1; ; from += CHUNK) {
        const answer = await read(from);
        if (answer.lines === null || answer.total === null) return { kind: "unreadable" };
        if (answer.total > MAX_LINES) return { kind: "long" };
        lines.push(...answer.lines);
        if (lines.length >= answer.total || answer.lines.length === 0)
          return { kind: "read", text: lines.join("\n") };
      }
    })().then(
      (s) => live && setState(s),
      () => live && setState({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [pull.platform, pull.repo, pull.number, head, path]);
  return state;
}

const NOTE: Record<Exclude<FileText["kind"], "read">, string> = {
  reading: "Reading the file…",
  unreadable: "This file cannot be read as text. Its diff shows what changed.",
  long: `This file is longer than ${MAX_LINES.toLocaleString("en")} lines. Its diff shows what changed.`,
  failed: "Could not read the file. Show the diff, or try again later.",
};

/** The file as a page; while it is read, or when it cannot be, one quiet line says so. */
export function RenderedMarkdown(props: { source: ContextSource; path: string }) {
  const state = useFileText(props.source, props.path);
  if (state.kind !== "read")
    return (
      <p className="card-pad subtle small m-0" role={state.kind === "failed" ? "alert" : undefined}>
        {NOTE[state.kind]}
      </p>
    );
  return (
    <div className="diff-rendered">
      <PlatformMarkdown text={state.text} />
    </div>
  );
}

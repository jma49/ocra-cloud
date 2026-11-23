import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import type { DiffLine } from "./diff.js";

// A diff's code in the colours of its language. The highlighter and each
// grammar are fetched when a diff first needs them, so a page without code
// pays nothing. A theme of CSS variables names each token's kind, which the
// page draws with its own tokens (`.tok-*`, web/src/styles/syntax.css).

/** A run of one line's text and the kind of token it is; null for plain text. */
export type CodeRun = { text: string; kind: string | null };

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS: Record<string, Grammar> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
};

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
};

/** The grammar a path is read with, or null for a kind of file left plain. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "docker";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (BY_EXTENSION[name.slice(dot + 1)] ?? null);
}

/** Past these a diff stays plain: a generated or minified file is not read line by line. */
const MAX_LINES = 4000;
/** Lines read between two turns of the page. */
const SHARE = 40;
const MAX_LINE_CHARS = 1000;

const THEME = "css-variables";
const KIND = /--shiki-token-([a-z-]+)/;

let shared: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  shared ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([core, engine]) =>
      core.createHighlighterCore({
        themes: [core.createCssVariablesTheme({ name: THEME, fontStyle: false })],
        langs: [],
        engine: engine.createJavaScriptRegexEngine(),
      }),
  );
  return shared;
}

async function ready(lang: string): Promise<HighlighterCore | null> {
  const grammar = GRAMMARS[lang];
  if (!grammar) return null;
  const core = await highlighter();
  let load = loaded.get(lang);
  if (!load) {
    load = grammar().then((g) => core.loadLanguage(...g.default));
    loaded.set(lang, load);
  }
  await load;
  return core;
}

let last: Promise<void> = Promise.resolve();
function turn(): Promise<void> {
  last = last.then(() => new Promise((next) => setTimeout(next)));
  return last;
}

function runsOf(core: HighlighterCore, lang: string, code: string): CodeRun[][] {
  return core.codeToTokensBase(code, { lang, theme: THEME }).map((line) =>
    line.map((token) => ({
      text: token.content,
      kind: KIND.exec(token.color ?? "")?.[1] ?? null,
    })),
  );
}

/**
 * Each line's runs, by the line's index; a line left out is drawn plain. Every
 * hunk is read twice, as the file was and as it is, so a removed line is
 * coloured in the code it stood in. A hunk that starts inside a comment or a
 * string is read as if it did not: the platform sends no more of the file.
 * A long diff is read a few hunks at a time, the page drawn between two, and
 * `progress` gets what is read so far after each.
 */
export async function highlightDiff(
  path: string,
  lines: readonly DiffLine[],
  progress?: (runs: ReadonlyMap<number, CodeRun[]>) => void,
): Promise<Map<number, CodeRun[]>> {
  const out = new Map<number, CodeRun[]>();
  const lang = languageOf(path);
  if (!lang || lines.length > MAX_LINES) return out;
  if (lines.some((l) => l.text.length > MAX_LINE_CHARS)) return out;
  const core = await ready(lang);
  if (!core) return out;
  // A share of a diff at a time, the page drawn between two: a long pull request stays usable.
  await turn();
  let since = 0;
  const side = (from: number, to: number, skip: "add" | "del") => {
    const at: number[] = [];
    for (let i = from; i < to; i++) if (lines[i]?.kind !== skip) at.push(i);
    const runs = runsOf(core, lang, at.map((i) => lines[i]?.text ?? "").join("\n"));
    at.forEach((i, n) => {
      // The old side's context lines are the new side's too: the new side names them.
      if (skip === "del" || lines[i]?.kind === "del") out.set(i, runs[n] ?? []);
    });
  };
  let from = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i]?.kind !== "hunk") continue;
    if (i > from) {
      if (since >= SHARE) {
        progress?.(new Map(out));
        await turn();
        since = 0;
      }
      side(from, i, "del");
      if (lines.slice(from, i).some((l) => l.kind === "del")) side(from, i, "add");
      since += i - from;
    }
    from = i + 1;
  }
  return out;
}

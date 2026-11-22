import type { CodeOwnerKind, CodePlatformKind } from "./shared/index.js";

// A repository's CODEOWNERS, read as each platform documents it: on GitHub
// the last matching rule of the file wins; on GitLab the last matching rule
// of each section wins and the sections' owners add up, an entry without
// owners taking its section's. Patterns use `*`, `?` and `**`; a negation
// (`!`) is not part of either syntax and its line is skipped.

/** Where each platform looks for the file, the first found winning. */
export const CODEOWNERS_PATHS: Record<CodePlatformKind, readonly string[]> = {
  github: [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"],
  gitlab: ["CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS"],
};

/** GitHub ignores a file past 3 MB; this reads far less. */
export const MAX_CODEOWNERS_BYTES = 128 * 1024;
const MAX_RULES = 5_000;
const MAX_OWNERS_PER_RULE = 50;

export type Owner = { name: string; kind: CodeOwnerKind };
type Rule = { section: string; match: Matcher; owners: Owner[] };
export type CodeOwners = { rules: Rule[]; budget: Budget };

const SECTION = /^\^?\[([^\]]+)\](?:\[\d+\])?(?:\s+(.*))?$/;
const USER = /^@[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const GROUP = /^@[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const ROLE = /^@@[a-z]+$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function ownerOf(token: string, flavor: CodePlatformKind): Owner | undefined {
  if (flavor === "gitlab" && ROLE.test(token)) return { name: token.slice(2), kind: "role" };
  if (USER.test(token)) return { name: token.slice(1), kind: "user" };
  if (GROUP.test(token)) return { name: token.slice(1), kind: "team" };
  if (EMAIL.test(token)) return { name: token, kind: "email" };
  return undefined;
}

/** Splits on whitespace a backslash does not escape. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function ownersOf(words: string[], flavor: CodePlatformKind): Owner[] {
  const owners: Owner[] = [];
  for (const word of words) {
    if (word.startsWith("#")) break;
    const owner = ownerOf(word, flavor);
    if (owner && owners.length < MAX_OWNERS_PER_RULE) owners.push(owner);
  }
  return owners;
}

/** Steps of matching one parsed file may take over all its paths, so a hostile file cannot hold the request. */
const MAX_MATCH_STEPS = 10_000_000;

type Budget = { steps: number };
/** One pattern character, or a wildcard as the regular expression it stood for reads it (`.` stops at a line end). */
type Token = { lit: string } | { wild: "one" | "star" | "any" | "dirs" | "under" };
type Matcher = { test(path: string, budget?: Budget): boolean };

const isLineEnd = (ch: string) => ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
const isSlash = (ch: string) => ch === "/";

/** For each start j, the positions j..e, e being the first at or after j that stops the run; sorted. */
function extend(at: readonly number[], path: string, stops: (ch: string) => boolean): number[] {
  const out: number[] = [];
  let last = -1;
  for (const j of at) {
    if (j <= last) continue;
    let e = j;
    while (e < path.length && !stops(path[e] ?? "")) e++;
    for (let k = j; k <= e; k++) out.push(k);
    last = e;
  }
  return out;
}

/** Two sorted lists as one, each position once. */
function merge(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i] ?? Infinity;
    const y = b[j] ?? Infinity;
    const next = Math.min(x, y);
    if (x === next) i++;
    if (y === next) j++;
    out.push(next);
  }
  return out;
}

/** The positions in path a token can end at from those in at. */
function step(token: Token, at: readonly number[], path: string): number[] {
  const out: number[] = [];
  if ("lit" in token) {
    for (const j of at) if (path[j] === token.lit) out.push(j + 1);
    return out;
  }
  switch (token.wild) {
    case "one":
      for (const j of at) if (j < path.length && path[j] !== "/") out.push(j + 1);
      return out;
    case "star":
      return extend(at, path, isSlash);
    case "any":
      return extend(at, path, isLineEnd);
    case "dirs":
      for (const k of extend(at, path, isLineEnd)) if (path[k] === "/") out.push(k + 1);
      return merge(at, out);
    case "under":
      for (const k of at) if (path[k] === "/") out.push(k + 1);
      return merge(at, extend(out, path, isLineEnd));
  }
}

// Sets of positions rather than a regular expression: a backtracking
// engine takes exponential time over several `**` in one pattern, and the
// file is the repository's own text.
function matcherOf(tokens: readonly Token[]): Matcher {
  // Each run of plain characters is in any path the pattern matches.
  const runs = tokens
    .map((t) => ("lit" in t ? t.lit : "\0"))
    .join("")
    .split("\0")
    .filter(Boolean);
  return {
    test(path, budget = { steps: MAX_MATCH_STEPS }) {
      if (!runs.every((run) => path.includes(run))) return false;
      let at = [0];
      for (const token of tokens) {
        at = step(token, at, path);
        budget.steps -= at.length + 1;
        if (budget.steps < 0 || at.length === 0) return false;
      }
      return at.at(-1) === path.length;
    },
  };
}

/** A pattern as a matcher of repository paths; undefined for one it cannot read. */
export function patternMatcher(pattern: string, flavor: CodePlatformKind): Matcher | undefined {
  if (pattern === "" || pattern.startsWith("!")) return undefined;
  const directory = pattern.endsWith("/");
  const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (body === "") return pattern.startsWith("/") ? { test: () => true } : undefined;
  // GitHub reads a pattern as .gitignore does: a slash before its end anchors it to the root.
  // GitLab anchors only one that starts with a slash.
  const anchored = pattern.startsWith("/") || (flavor === "github" && body.includes("/"));
  const tokens: Token[] = anchored ? [] : [{ wild: "dirs" }];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === "*" && body[i + 1] === "*") {
      const slash = body[i + 2] === "/";
      tokens.push({ wild: slash ? "dirs" : "any" });
      i += slash ? 2 : 1;
    } else if (ch === "*") tokens.push({ wild: "star" });
    else if (ch === "?") tokens.push({ wild: "one" });
    else tokens.push({ lit: ch });
  }
  const last = body.split("/").at(-1) ?? "";
  // `docs/*` owns docs' own files, not those of its subdirectories; a plain name owns all under it.
  if (directory) tokens.push({ lit: "/" }, { wild: "any" });
  else if (!(last.includes("*") && last !== "**")) tokens.push({ wild: "under" });
  return matcherOf(tokens);
}

export function parseCodeOwners(text: string, flavor: CodePlatformKind): CodeOwners {
  const rules: Rule[] = [];
  let section = "";
  let defaults: Owner[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (rules.length >= MAX_RULES) break;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = flavor === "gitlab" ? SECTION.exec(line) : null;
    if (header) {
      section = (header[1] ?? "").trim().toLowerCase();
      defaults = ownersOf(tokens(header[2] ?? ""), flavor);
      continue;
    }
    const [pattern = "", ...rest] = tokens(line);
    const match = patternMatcher(pattern, flavor);
    if (!match) continue;
    const owners = ownersOf(rest, flavor);
    const ownersNamed = rest.length > 0 && !rest[0]?.startsWith("#");
    rules.push({
      section,
      match,
      owners: flavor === "gitlab" && !ownersNamed ? defaults : owners,
    });
  }
  return { rules, budget: { steps: MAX_MATCH_STEPS } };
}

/** The owners of one path per section (GitHub's file is one section): each one's last matching rule. */
export function ownerGroupsOfPath(file: CodeOwners, path: string): Owner[][] {
  const bySection = new Map<string, Owner[]>();
  for (const rule of file.rules) {
    if (rule.match.test(path, file.budget)) bySection.set(rule.section, rule.owners);
  }
  return [...bySection.values()].filter((owners) => owners.length > 0);
}

/** The owners of one path: the last matching rule's, or on GitLab each section's last. */
export function ownersOfPath(file: CodeOwners, path: string): Owner[] {
  const seen = new Set<string>();
  const owners: Owner[] = [];
  for (const list of ownerGroupsOfPath(file, path)) {
    for (const o of list) {
      const key = `${o.kind}:${o.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      owners.push(o);
    }
  }
  return owners;
}

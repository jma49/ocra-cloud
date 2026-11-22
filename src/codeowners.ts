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
type Rule = { section: string; match: RegExp; owners: Owner[] };
export type CodeOwners = { rules: Rule[] };

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

const literal = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** A pattern as a regular expression over a repository path; undefined for one it cannot read. */
export function patternRegex(pattern: string, flavor: CodePlatformKind): RegExp | undefined {
  if (pattern === "" || pattern.startsWith("!")) return undefined;
  const directory = pattern.endsWith("/");
  const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (body === "") return pattern.startsWith("/") ? /^/ : undefined;
  // GitHub reads a pattern as .gitignore does: a slash before its end anchors it to the root.
  // GitLab anchors only one that starts with a slash.
  const anchored = pattern.startsWith("/") || (flavor === "github" && body.includes("/"));
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (ch === "*" && body[i + 1] === "*") {
      const slash = body[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += literal(ch);
  }
  const last = body.split("/").at(-1) ?? "";
  // `docs/*` owns docs' own files, not those of its subdirectories; a plain name owns all under it.
  const under = directory ? "/.*" : last.includes("*") && last !== "**" ? "" : "(?:/.*)?";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}${under}$`);
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
    const match = patternRegex(pattern, flavor);
    if (!match) continue;
    const owners = ownersOf(rest, flavor);
    const ownersNamed = rest.length > 0 && !rest[0]?.startsWith("#");
    rules.push({
      section,
      match,
      owners: flavor === "gitlab" && !ownersNamed ? defaults : owners,
    });
  }
  return { rules };
}

/** The owners of one path: the last matching rule's, or on GitLab each section's last. */
export function ownersOfPath(file: CodeOwners, path: string): Owner[] {
  const bySection = new Map<string, Owner[]>();
  for (const rule of file.rules) {
    if (rule.match.test(path)) bySection.set(rule.section, rule.owners);
  }
  const seen = new Set<string>();
  const owners: Owner[] = [];
  for (const list of bySection.values()) {
    for (const o of list) {
      const key = `${o.kind}:${o.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      owners.push(o);
    }
  }
  return owners;
}

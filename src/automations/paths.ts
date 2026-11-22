import type { AutomationPaths, AutomationSkipReason } from "../shared/index.js";
import { globMatch } from "./rules.js";

// A rule's paths, read as the engine reads a learning's (.gitignore style,
// case ignored), matched name by name with the title's wildcard matcher:
// `**` stands for any run of names, and backs up only to the last one, so
// the time is bounded by the lengths whatever the globs, with no regular
// expression built from them.

/** The changed files read from the platform; truncated when the pull request has more. */
export type ChangedPaths = { paths: readonly string[]; truncated: boolean };

function expand(glob: string): string[][] {
  const rooted = /^\.?\//.test(glob);
  const path = glob.replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
  if (path === "") return [["**"]];
  const anywhere = rooted || path.includes("/") ? path : `**/${path}`;
  const names = anywhere.split("/").filter((n) => n !== "");
  return names.at(-1) === "**" ? [names] : [names, [...names, "**"]];
}

function namesMatch(glob: readonly string[], names: readonly string[]): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < names.length) {
    const g = glob[i];
    if (g !== undefined && g !== "**" && globMatch(g, names[j] ?? "")) {
      i++;
      j++;
    } else if (g === "**") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else {
      return false;
    }
  }
  while (glob[i] === "**") i++;
  return i === glob.length;
}

/** Whether the path matches any of the globs. */
export function pathMatcher(globs: readonly string[]): (path: string) => boolean {
  const expanded = globs.flatMap(expand);
  return (path) => {
    const names = path.split("/").filter((n) => n !== "");
    return expanded.some((g) => namesMatch(g, names));
  };
}

/**
 * Whether the rule's paths hold for the changed files: true or false, or
 * why it cannot be told. A file past those read could change the answer
 * only while the ones read did not settle it.
 */
export function pathsHold(
  rule: AutomationPaths,
  changed: ChangedPaths | null,
): boolean | AutomationSkipReason {
  if (!changed) return "paths_unavailable";
  const included = rule.include ? pathMatcher(rule.include) : () => true;
  const excluded = rule.exclude ? pathMatcher(rule.exclude) : () => false;
  const selected = (p: string) => included(p) && !excluded(p);
  if (rule.every) {
    if (!changed.paths.every(selected)) return false;
    if (changed.truncated) return "too_many_files";
    return changed.paths.length > 0;
  }
  if (changed.paths.some(selected)) return true;
  return changed.truncated ? "too_many_files" : false;
}

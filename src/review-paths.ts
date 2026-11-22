// The directories a pull request changes, as suggested reviewers compare
// them: each changed file's top-level and second-level directory (a file
// at the root has none), the ones with the most files first, at most
// MAX_PULL_PREFIXES, so a large pull request keeps a bounded set.

export const MAX_PULL_PREFIXES = 32;
const MAX_PREFIX_LENGTH = 512;

export function pathPrefixes(paths: Iterable<string>): string[] {
  const files = new Map<string, number>();
  for (const path of new Set(paths)) {
    const dirs = path.split("/").slice(0, -1).filter(Boolean);
    for (const prefix of [dirs[0], dirs.length > 1 ? `${dirs[0]}/${dirs[1]}` : undefined]) {
      if (!prefix || prefix.length > MAX_PREFIX_LENGTH) continue;
      files.set(prefix, (files.get(prefix) ?? 0) + 1);
    }
  }
  return [...files]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_PULL_PREFIXES)
    .map(([prefix]) => prefix);
}

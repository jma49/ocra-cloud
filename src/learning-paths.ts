import { pathMatcher } from "./automations/paths.js";
import type { RepoTree } from "./platforms/contents.js";

// A learning whose path no longer names a file (the module moved, or was
// renamed) is never given to a review by its path again: only its keywords
// can still bring it in. Its paths are matched as the engine matches them.

/**
 * Per learning with any path that matches no file of the tree, those paths;
 * null when the tree is not known in full, since a file not listed could match.
 */
export function unmatchedPaths(
  learnings: readonly { id: string; paths: readonly string[] }[],
  tree: RepoTree | null,
): Record<string, string[]> | null {
  if (!tree || tree.truncated) return null;
  const files = tree.entries.map((e) => e.path);
  const found = new Map<string, boolean>();
  const matches = (glob: string) => {
    let hit = found.get(glob);
    if (hit === undefined) {
      const match = pathMatcher([glob]);
      hit = files.some(match);
      found.set(glob, hit);
    }
    return hit;
  };
  const unmatched: Record<string, string[]> = {};
  for (const l of learnings) {
    const gone = l.paths.filter((p) => !matches(p));
    if (gone.length > 0) unmatched[l.id] = gone;
  }
  return unmatched;
}

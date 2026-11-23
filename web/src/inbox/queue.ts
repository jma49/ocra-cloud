import { useSyncExternalStore } from "react";

// The inbox's rows in the order last shown, kept while the console is open,
// so a pull request's page can step to the ones beside it.

let queue: readonly string[] = [];
const listeners = new Set<() => void>();
const subscribe = (tell: () => void) => {
  listeners.add(tell);
  return () => listeners.delete(tell);
};

/** A repository's slash may arrive encoded or not: one spelling to compare. */
const plain = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

export function rememberQueue(paths: readonly string[]): void {
  if (paths.length === queue.length && paths.every((p, i) => p === queue[i])) return;
  queue = paths;
  for (const tell of listeners) tell();
}

export type Beside = { at: number; total: number; previous: string | null; next: string | null };

/** Where `path` stands in the inbox as last shown; null when it was not in it. */
export function useBeside(path: string): Beside | null {
  const paths = useSyncExternalStore(subscribe, () => queue);
  const at = paths.findIndex((p) => plain(p) === plain(path));
  if (at < 0) return null;
  return {
    at: at + 1,
    total: paths.length,
    previous: paths[at - 1] ?? null,
    next: paths[at + 1] ?? null,
  };
}

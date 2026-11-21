import { useCallback, useEffect, useRef, useState } from "react";

// What the console last read, kept so a page opens on it at once and then
// refreshes: in memory for this tab, and in IndexedDB so a reload or the
// next visit starts from it too. It belongs to one account: a different
// sign-in clears it, and so does signing out. Storage can be missing or
// refuse (a private window, blocked site data); then only memory is kept.

const DB = "ocra-cache";
const STORE = "answers";
/** How long a stored answer is worth showing while the fresh one loads. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Entry = { data: unknown; at: number };
const memory = new Map<string, Entry>();
let owner: string | undefined;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    // A store that never answers must not hold the console back.
    setTimeout(() => resolve(null), 1000);
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let dbPromise: Promise<IDBDatabase | null> | undefined;
const db = () => {
  dbPromise ??= openDb();
  return dbPromise;
};

async function run<T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>) {
  const d = await db();
  if (!d) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const req = act(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const OWNER_KEY = "\u0000owner";

/**
 * Who the cache belongs to, from /me: a different account than the one that
 * filled it empties it first.
 */
export async function cacheFor(login: string): Promise<void> {
  if (owner === login) return;
  const stored = await run<string>("readonly", (s) => s.get(OWNER_KEY) as IDBRequest<string>);
  if (stored !== login) await clearCache();
  owner = login;
  await run("readwrite", (s) => s.put(login, OWNER_KEY));
}

/** Forgets everything read: on sign-out, or when the session is gone. */
export async function clearCache(): Promise<void> {
  memory.clear();
  owner = undefined;
  await run("readwrite", (s) => s.clear());
}

async function stored(key: string): Promise<Entry | undefined> {
  const hit = memory.get(key);
  if (hit) return hit;
  const e = await run<Entry>("readonly", (s) => s.get(key) as IDBRequest<Entry>);
  if (!e || Date.now() - e.at > MAX_AGE_MS) return undefined;
  memory.set(key, e);
  return e;
}

function keep(key: string, data: unknown): void {
  const e = { data, at: Date.now() };
  memory.set(key, e);
  void run("readwrite", (s) => s.put(e, key));
}

/**
 * The answer for `key`, shown from the cache at once when there is one and
 * refreshed from `load`. `stale` is true while what is shown came from the
 * cache and the fresh answer is still on its way. `change` edits what is
 * shown at once (an optimistic update) and gives back how to undo it.
 */
export function useCached<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{
    key: string;
    data: T | undefined;
    error: unknown;
    stale: boolean;
  }>(() => {
    const hit = memory.get(key);
    return { key, data: hit?.data as T | undefined, error: null, stale: true };
  });
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const asked = useRef(0);

  // A new key starts from that key's cache, never from the previous key's data.
  const current =
    state.key === key
      ? state
      : { key, data: memory.get(key)?.data as T | undefined, error: null, stale: true };
  if (current !== state) setState(current);

  // biome-ignore lint/correctness/useExhaustiveDependencies: n asks for a reload
  useEffect(() => {
    let live = true;
    const ask = ++asked.current;
    const mine = () => live && ask === asked.current;
    stored(key).then((hit) => {
      if (mine() && hit) {
        setState((s) =>
          s.key === key && s.data === undefined ? { ...s, data: hit.data as T } : s,
        );
      }
    });
    loadRef.current().then(
      (data) => {
        keep(key, data);
        if (mine()) setState({ key, data, error: null, stale: false });
      },
      (error) => {
        if (mine()) setState((s) => ({ ...s, error, stale: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, n]);

  const reload = useCallback(() => setN((x) => x + 1), []);
  const change = useCallback(
    (edit: (data: T) => T) => {
      // An answer already on its way was asked before this edit: drop it.
      asked.current++;
      let before: T | undefined;
      setState((s) => {
        if (s.key !== key || s.data === undefined) return s;
        before = s.data;
        const data = edit(s.data);
        keep(key, data);
        return { ...s, data };
      });
      return () =>
        setState((s) => {
          if (s.key !== key || before === undefined) return s;
          keep(key, before);
          return { ...s, data: before };
        });
    },
    [key],
  );
  return {
    data: current.data,
    error: current.error,
    /** No answer yet, cached or fresh. */
    loading: current.data === undefined && current.error === null,
    stale: current.stale,
    reload,
    change,
  };
}

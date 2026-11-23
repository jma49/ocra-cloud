import { useCallback, useEffect, useRef, useState } from "react";
import { api, forgetPrefetched } from "./api.js";

const DB = "ocra-cache";
const STORE = "answers";
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

/** A different account than the one that filled the cache empties it first. */
export async function cacheFor(login: string): Promise<void> {
  if (owner === login) return;
  const stored = await run<string>("readonly", (s) => s.get(OWNER_KEY) as IDBRequest<string>);
  if (stored !== login) await clearCache();
  owner = login;
  await run("readwrite", (s) => s.put(login, OWNER_KEY));
}

export async function clearCache(): Promise<void> {
  memory.clear();
  forgetPrefetched();
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

function keep(key: string, data: unknown, memoryOnly = false): void {
  const e = { data, at: Date.now() };
  memory.set(key, e);
  if (!memoryOnly) void run("readwrite", (s) => s.put(e, key));
}

/** Shows the cached answer for `key` at once, then refreshes it. `change` is an optimistic edit that returns its undo. */
export function useCached<T>(
  key: string,
  load: () => Promise<T>,
  { memoryOnly = false }: { memoryOnly?: boolean } = {},
) {
  const [state, setState] = useState<{
    key: string;
    data: T | undefined;
    /** When the data shown was read from the server. */
    at: number | undefined;
    error: unknown;
    stale: boolean;
  }>(() => {
    const hit = memory.get(key);
    return { key, data: hit?.data as T | undefined, at: hit?.at, error: null, stale: true };
  });
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const asked = useRef(0);

  const current =
    state.key === key
      ? state
      : {
          key,
          data: memory.get(key)?.data as T | undefined,
          at: memory.get(key)?.at,
          error: null,
          stale: true,
        };
  if (current !== state) setState(current);

  // biome-ignore lint/correctness/useExhaustiveDependencies: n asks for a reload
  useEffect(() => {
    let live = true;
    const ask = ++asked.current;
    const mine = () => live && ask === asked.current;
    stored(key).then((hit) => {
      if (mine() && hit) {
        setState((s) =>
          s.key === key && s.data === undefined ? { ...s, data: hit.data as T, at: hit.at } : s,
        );
      }
    });
    loadRef.current().then(
      (data) => {
        keep(key, data, memoryOnly);
        if (mine()) setState({ key, data, at: Date.now(), error: null, stale: false });
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
        keep(key, data, memoryOnly);
        return { ...s, data };
      });
      return () =>
        setState((s) => {
          if (s.key !== key || before === undefined) return s;
          keep(key, before, memoryOnly);
          return { ...s, data: before };
        });
    },
    [key, memoryOnly],
  );
  return {
    data: current.data,
    readAt: current.at,
    error: current.error,
    loading: current.data === undefined && current.error === null,
    stale: current.stale,
    reload,
    change,
  };
}

/** `useCached` for a GET of the API: the path is the key. `memoryOnly` keeps large answers out of the browser's store. */
export function useRead<T>(path: string, options: { memoryOnly?: boolean } = {}) {
  return useCached(path, () => api<T>(path), options);
}

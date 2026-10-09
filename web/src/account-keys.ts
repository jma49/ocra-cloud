import { api, type Key } from "./api.js";

// The account's keys, which Overview, Keys, Agents and Defaults all read,
// and each read runs a 90-day aggregate on the server (audit C11): one
// request serves every page for KEYS_MAX_AGE_MS, and saving or deleting a
// key forgets it. A failure is not kept: the next page asks again.

const KEYS_MAX_AGE_MS = 60_000;
type Keys = { keys: Key[] };
let cached: { at: number; keys: Promise<Keys> } | undefined;

/** GET /api/keys, shared by the pages that read it. */
export function loadKeys(): Promise<Keys> {
  if (!cached || Date.now() - cached.at > KEYS_MAX_AGE_MS) {
    const keys = api<Keys>("/keys").catch((e: unknown) => {
      if (cached?.keys === keys) cached = undefined;
      throw e;
    });
    cached = { at: Date.now(), keys };
  }
  return cached.keys;
}

/** After a key is saved or deleted, and in tests. */
export function forgetKeys(): void {
  cached = undefined;
}

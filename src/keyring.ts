import { decryptWithAny, keyBinding, type MasterKeys, type Sealed } from "./crypto.js";
import type { Scoped } from "./db/scoped.js";

// The account's stored model keys: finding one and decrypting it, for the
// keys routes and the gateway.

export function masterKeys(env: Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">): MasterKeys {
  return { current: env.MASTER_KEY, previous: env.MASTER_KEY_PREVIOUS };
}

/** The account's stored key row for a provider, still encrypted, or undefined. */
export async function storedKey(data: Scoped, provider: string) {
  return (await data.list("providerKeys")).find((r) => r.provider === provider);
}

/** A stored key row's plaintext, under the current or the previous master key. */
export function decryptKey(
  env: Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">,
  row: Sealed & { accountId: string; provider: string },
): Promise<string> {
  return decryptWithAny(masterKeys(env), row, keyBinding(row.accountId, row.provider));
}

/** The account's key for a provider, decrypted, or undefined. */
export async function keyFor(
  data: Scoped,
  keys: MasterKeys,
  provider: string,
): Promise<string | undefined> {
  const row = await storedKey(data, provider);
  return row ? decryptWithAny(keys, row, keyBinding(row.accountId, row.provider)) : undefined;
}

import { decryptWithAny, encryptSecret, type MasterKeys } from "../../crypto.js";
import type { Db } from "../../db/client.js";
import { type StoredSetting, storedSettings, storeSettings } from "../../db/server-settings.js";
import { FIELDS, isSecret, type SettingName, type Settings } from "./settings.js";

// The saved settings, opened and sealed: a secret is sealed under the master
// key, bound to its name, so a sealed value moved to another name does not open.

const binding = (name: string) => `ocra-server-setting:v1|${name}`;

/** The saved settings, secrets opened; a name no longer a setting is left out. */
export async function loadSettings(db: Db, keys: MasterKeys): Promise<Settings> {
  const out: Settings = {};
  for (const row of await storedSettings(db)) {
    if (!(row.name in FIELDS)) continue;
    const name = row.name as SettingName;
    if (!row.sealed) {
      out[name] = row.value;
      continue;
    }
    const [wrappedKey = "", ciphertext = ""] = row.value.split(".");
    out[name] = await decryptWithAny(keys, { wrappedKey, ciphertext }, binding(name));
  }
  return out;
}

/** Saves each value, and removes each setting given null. */
export async function saveSettings(
  db: Db,
  masterKey: string,
  changes: Partial<Record<SettingName, string | null>>,
  now: Date,
): Promise<void> {
  const written: StoredSetting[] = [];
  const removed: string[] = [];
  for (const [name, value] of Object.entries(changes) as [SettingName, string | null][]) {
    if (value === null) {
      removed.push(name);
    } else if (isSecret(name)) {
      const sealed = await encryptSecret(masterKey, value, binding(name));
      written.push({ name, value: `${sealed.wrappedKey}.${sealed.ciphertext}`, sealed: true });
    } else {
      written.push({ name, value, sealed: false });
    }
  }
  await storeSettings(db, written, removed, now);
}

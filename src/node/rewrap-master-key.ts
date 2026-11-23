import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { rotateMasterKey } from "../crypto.js";
import { databaseSealedStore } from "../db/sealed-rows.js";
import { openDatabase } from "./host.js";

// A self-hosted server's master key rotation (docs/rotation.md), in its
// image: `node dist/rewrap-master-key.mjs [--apply]`. It reads what the
// server reads: DATABASE_URL, and the old key from MASTER_KEY_PREVIOUS, the
// new one from MASTER_KEY. Without --apply it only checks. Neither key, nor
// anything a row seals, is printed.

const { values } = parseArgs({ options: { apply: { type: "boolean" } } });
const oldKey = process.env.MASTER_KEY_PREVIOUS?.trim();
const newKey = process.env.MASTER_KEY?.trim();
if (!oldKey || !newKey) {
  console.error(
    "set MASTER_KEY to the new key and MASTER_KEY_PREVIOUS to the old one, as during a rotation",
  );
  process.exit(2);
}
if (oldKey === newKey) {
  console.error("MASTER_KEY and MASTER_KEY_PREVIOUS are the same key");
  process.exit(2);
}

const { db, close } = await openDatabase(process.env.DATABASE_URL || "file:ocra-cloud.db", {
  migrations: resolve(process.env.MIGRATIONS_DIR || "migrations"),
  migrate: false,
});
try {
  process.exitCode = await rotateMasterKey(
    databaseSealedStore(db),
    { old: oldKey, new: newKey },
    !!values.apply,
  );
} finally {
  close();
}

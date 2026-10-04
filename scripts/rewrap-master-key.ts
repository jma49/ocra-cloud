// Re-wraps every stored data key from the old master key to the new one
// (docs/rotation.md). Run with Node: node scripts/rewrap-master-key.ts
// --old <file> --new <file> [--apply] [--local]. Without --apply it only
// checks: every row must open with the old key and, re-wrapped, decrypt with
// the new one. Key values are read from files and never printed.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decryptSecret, rewrap } from "../src/crypto.ts";

const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    apply: { type: "boolean" },
    local: { type: "boolean" },
  },
});
if (!values.old || !values.new) {
  console.error(
    "usage: node scripts/rewrap-master-key.ts --old <file> --new <file> [--apply] [--local]",
  );
  process.exit(2);
}
const oldKey = readFileSync(values.old, "utf8").trim();
const newKey = readFileSync(values.new, "utf8").trim();
if (oldKey === newKey) {
  console.error("the old and the new master key are the same");
  process.exit(2);
}
const where = values.local ? "--local" : "--remote";

function d1(args: string[]): unknown {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ocra-cloud", where, "--json", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out.slice(out.indexOf("[")));
}

type Row = { id: string; wrapped_key: string; ciphertext: string };
const [result] = d1(["--command", "SELECT id, wrapped_key, ciphertext FROM provider_keys"]) as [
  { results: Row[] },
];
const rows = result.results;
const updates: string[] = [];
let failed = 0;
for (const row of rows) {
  try {
    const wrapped = await rewrap(oldKey, newKey, row.wrapped_key);
    // The point of the rotation: the new key must open what the old one did.
    const before = await decryptSecret(oldKey, {
      wrappedKey: row.wrapped_key,
      ciphertext: row.ciphertext,
    });
    const after = await decryptSecret(newKey, { wrappedKey: wrapped, ciphertext: row.ciphertext });
    if (before !== after) throw new Error("mismatch");
    if (!/^[A-Za-z0-9+/=]+$/.test(wrapped) || !/^[\w-]+$/.test(row.id))
      throw new Error("unexpected value");
    updates.push(
      `UPDATE provider_keys SET wrapped_key = '${wrapped}' WHERE id = '${row.id}' AND wrapped_key = '${row.wrapped_key}';`,
    );
  } catch {
    failed++;
    console.error(
      `row ${row.id}: does not open with the old key, or does not verify with the new one`,
    );
  }
}
console.log(`${rows.length} key(s), ${updates.length} ready, ${failed} failed`);
if (failed > 0) process.exit(1);
if (!values.apply) {
  console.log("Checked only. Run again with --apply to write.");
  process.exit(0);
}
if (updates.length === 0) process.exit(0);
const file = join(tmpdir(), `rewrap-${process.pid}.sql`);
writeFileSync(file, `${updates.join("\n")}\n`, { mode: 0o600 });
try {
  d1(["--file", file]);
} finally {
  rmSync(file, { force: true });
}
console.log(
  `Re-wrapped ${updates.length} key(s). Next: remove MASTER_KEY_PREVIOUS (docs/rotation.md).`,
);

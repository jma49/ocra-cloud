// Binds every stored provider key to its account and provider (#16,
// docs/rotation.md). Run with Node: node scripts/bind-provider-keys.ts
// --master <file> [--apply] [--local]. Without --apply it only checks.
// Each unbound row is re-sealed with its binding, then verified: the new
// pair must open with the binding to the same key as before, and must not
// open without it. Key values are read from a file and never printed.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decryptSecret, encryptSecret, keyBinding } from "../src/crypto.ts";

const { values } = parseArgs({
  options: {
    master: { type: "string" },
    apply: { type: "boolean" },
    local: { type: "boolean" },
  },
});
if (!values.master) {
  console.error("usage: node scripts/bind-provider-keys.ts --master <file> [--apply] [--local]");
  process.exit(2);
}
const master = readFileSync(values.master, "utf8").trim();
const where = values.local ? "--local" : "--remote";

function d1(args: string[]): unknown {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ocra-cloud", where, "--json", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out.slice(out.indexOf("[")));
}

type Row = {
  id: string;
  account_id: string;
  provider: string;
  wrapped_key: string;
  ciphertext: string;
};
const [result] = d1([
  "--command",
  "SELECT id, account_id, provider, wrapped_key, ciphertext FROM provider_keys",
]) as [{ results: Row[] }];
const rows = result.results;

const opens = (sealed: { wrappedKey: string; ciphertext: string }, binding?: string) =>
  decryptSecret(master, sealed, binding).then(
    (plain) => plain,
    () => undefined,
  );

const updates: string[] = [];
let bound = 0;
let failed = 0;
for (const row of rows) {
  const binding = keyBinding(row.account_id, row.provider);
  const current = { wrappedKey: row.wrapped_key, ciphertext: row.ciphertext };
  try {
    if ((await opens(current, binding)) !== undefined) {
      bound++;
      continue;
    }
    const plain = await opens(current);
    if (plain === undefined) throw new Error("does not open with the master key");
    const next = await encryptSecret(master, plain, binding);
    if ((await opens(next, binding)) !== plain) throw new Error("does not verify bound");
    if ((await opens(next)) !== undefined) throw new Error("still opens unbound");
    const base64 = /^[A-Za-z0-9+/=]+$/;
    if (!base64.test(next.wrappedKey) || !base64.test(next.ciphertext) || !/^[\w-]+$/.test(row.id))
      throw new Error("unexpected value");
    // Matches the old values too, so a key replaced meanwhile is left alone.
    updates.push(
      `UPDATE provider_keys SET wrapped_key = '${next.wrappedKey}', ciphertext = '${next.ciphertext}' WHERE id = '${row.id}' AND wrapped_key = '${row.wrapped_key}' AND ciphertext = '${row.ciphertext}';`,
    );
  } catch (error) {
    failed++;
    console.error(`row ${row.id}: ${(error as Error).message}`);
  }
}
console.log(
  `${rows.length} key(s): ${bound} already bound, ${updates.length} to bind, ${failed} failed`,
);
if (failed > 0) process.exit(1);
if (!values.apply) {
  console.log("Checked only. Run again with --apply to write.");
  process.exit(0);
}
if (updates.length === 0) process.exit(0);
const file = join(tmpdir(), `bind-keys-${process.pid}.sql`);
writeFileSync(file, `${updates.join("\n")}\n`, { mode: 0o600 });
try {
  d1(["--file", file]);
} finally {
  rmSync(file, { force: true });
}
console.log(`Bound ${updates.length} key(s). Run again without --apply: it should say 0 to bind.`);

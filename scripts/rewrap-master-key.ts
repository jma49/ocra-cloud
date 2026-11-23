// Re-wraps every sealed row's data key from the old master key to the new
// one on D1 (docs/rotation.md). Run with Node: node scripts/rewrap-master-key.ts
// --old <file> --new <file> [--apply] [--local]. Without --apply it only
// checks. Key values are read from files and never printed, nor is anything
// a row seals. A self-hosted server has its own entry on the same core
// (src/node/rewrap-master-key.ts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REWRAP_BATCH, rotateMasterKey, type SealedKind, type SealedStore } from "../src/crypto.ts";

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

type Row = Record<string, unknown>;

function d1(args: string[]): Row[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ocra-cloud", where, "--json", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const [result] = JSON.parse(out.slice(out.indexOf("["))) as [{ results?: Row[] }];
  return result?.results ?? [];
}

// D1 takes no bound parameters through wrangler: a row is found again by its
// rowid, an integer, and the wrapped keys the core checked are base64.
const d1Store: SealedStore<number> = {
  async *pages(kind: SealedKind) {
    const select = ["rowid AS row_id", kind.wrapped, kind.ciphertext, ...kind.columns].join(", ");
    for (let after = 0; ; ) {
      const rows = d1([
        "--command",
        `SELECT ${select} FROM ${kind.table} WHERE ${kind.wrapped} IS NOT NULL AND rowid > ${after} ORDER BY rowid LIMIT ${REWRAP_BATCH}`,
      ]);
      const page = rows.map((values) => {
        const ref = Number(values.row_id);
        if (!Number.isSafeInteger(ref)) throw new Error(`${kind.table}: a rowid is not an integer`);
        return { ref, values };
      });
      if (page.length > 0) yield page;
      if (page.length < REWRAP_BATCH) return;
      after = page.at(-1)?.ref ?? after;
    }
  },
  async write(kind, updates) {
    const sql = updates.map(
      (u) =>
        `UPDATE ${kind.table} SET ${kind.wrapped} = '${u.to}' WHERE rowid = ${u.ref} AND ${kind.wrapped} = '${u.from}';`,
    );
    const dir = mkdtempSync(join(tmpdir(), "rewrap-"));
    try {
      const file = join(dir, "batch.sql");
      writeFileSync(file, `${sql.join("\n")}\n`, { mode: 0o600 });
      d1(["--file", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  label: (ref) => `rowid ${ref}`,
};

process.exitCode = await rotateMasterKey(d1Store, { old: oldKey, new: newKey }, !!values.apply);

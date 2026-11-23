// Re-wraps every sealed row's data key from the old master key to the new
// one (docs/rotation.md). Run with Node: node scripts/rewrap-master-key.ts
// --old <file> --new <file> [--apply] [--local]. Without --apply it only
// checks: every row must open with the old key (or already with the new
// one) and, re-wrapped, decrypt with the new one. Key values are read from
// files and never printed, nor is anything a row seals.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  channelBinding,
  decryptSecret,
  keyBinding,
  platformTokenBinding,
  repoTokenBinding,
  rewrap,
} from "../src/crypto.ts";

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

/** Rows read, and UPDATE statements sent, per call to D1. */
const BATCH = 200;

type Row = Record<string, unknown>;

/**
 * A table's sealed columns and what each row is bound to: the binding must
 * be the one the service opens the row with, or the row would not open.
 */
type Kind = {
  table: string;
  wrapped: string;
  ciphertext: string;
  columns: string[];
  binding(row: Row): string;
};

const s = (v: unknown) => String(v);
const KINDS: Kind[] = [
  {
    table: "provider_keys",
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "provider"],
    binding: (r) => keyBinding(s(r.account_id), s(r.provider)),
  },
  {
    table: "platform_links",
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "platform", "host"],
    binding: (r) => platformTokenBinding(s(r.account_id), s(r.platform), s(r.host)),
  },
  {
    table: "review_repos",
    wrapped: "access_token_wrapped_key",
    ciphertext: "access_token_ciphertext",
    columns: ["account_id", "id"],
    binding: (r) => repoTokenBinding(s(r.account_id), s(r.id)),
  },
  {
    // Every kind of channel, a Slack member's direct messages included.
    table: "notify_channels",
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "id"],
    binding: (r) => channelBinding(s(r.account_id), s(r.id)),
  },
];

function d1(args: string[]): Row[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ocra-cloud", where, "--json", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const [result] = JSON.parse(out.slice(out.indexOf("["))) as [{ results?: Row[] }];
  return result?.results ?? [];
}

/** The table's sealed rows, in pages of BATCH by rowid. */
function* pages(kind: Kind): Generator<Row[]> {
  const select = [`rowid AS row_id`, kind.wrapped, kind.ciphertext, ...kind.columns].join(", ");
  for (let after = 0; ; ) {
    const rows = d1([
      "--command",
      `SELECT ${select} FROM ${kind.table} WHERE ${kind.wrapped} IS NOT NULL AND rowid > ${after} ORDER BY rowid LIMIT ${BATCH}`,
    ]);
    if (rows.length > 0) yield rows;
    if (rows.length < BATCH) return;
    after = Number(rows.at(-1)?.row_id);
  }
}

const opens = (key: string, wrappedKey: string, ciphertext: string, binding: string) =>
  decryptSecret(key, { wrappedKey, ciphertext }, binding).then(
    (plain) => plain,
    () => undefined,
  );

type Tally = { rows: number; ready: number; done: number; failed: number };

/** Each row's compare-and-set UPDATE, or why it gets none: already re-wrapped, or failed. */
async function scan(kind: Kind, tally: Tally): Promise<string[]> {
  const updates: string[] = [];
  for (const page of pages(kind)) {
    for (const row of page) {
      tally.rows++;
      const id = Number(row.row_id);
      const wrapped = s(row[kind.wrapped]);
      const ciphertext = s(row[kind.ciphertext]);
      const binding = kind.binding(row);
      try {
        if (!Number.isSafeInteger(id) || !/^[A-Za-z0-9+/=]+$/.test(wrapped)) {
          throw new Error("unexpected value");
        }
        const before = await opens(oldKey, wrapped, ciphertext, binding);
        if (before === undefined) {
          // Re-wrapped by an earlier run, or written by the service under the new key.
          if ((await opens(newKey, wrapped, ciphertext, binding)) === undefined) {
            throw new Error("opens with neither key");
          }
          tally.done++;
          continue;
        }
        const next = await rewrap(oldKey, newKey, wrapped, binding);
        // The point of the rotation: the new key must open what the old one did.
        if ((await opens(newKey, next, ciphertext, binding)) !== before) {
          throw new Error("mismatch");
        }
        if (!/^[A-Za-z0-9+/=]+$/.test(next)) throw new Error("unexpected value");
        tally.ready++;
        // Matching the old wrapped key leaves alone a row the service rewrote in between.
        updates.push(
          `UPDATE ${kind.table} SET ${kind.wrapped} = '${next}' WHERE rowid = ${id} AND ${kind.wrapped} = '${wrapped}';`,
        );
      } catch {
        tally.failed++;
        console.error(
          `${kind.table} rowid ${row.row_id}: opens with neither key, or does not verify with the new one`,
        );
      }
    }
  }
  return updates;
}

function write(updates: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rewrap-"));
  try {
    for (let i = 0; i < updates.length; i += BATCH) {
      const file = join(dir, `batch-${i / BATCH}.sql`);
      writeFileSync(file, `${updates.slice(i, i + BATCH).join("\n")}\n`, { mode: 0o600 });
      d1(["--file", file]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(apply: boolean): Promise<{ pending: number; failed: number }> {
  const updates: string[] = [];
  let failed = 0;
  for (const kind of KINDS) {
    const tally: Tally = { rows: 0, ready: 0, done: 0, failed: 0 };
    updates.push(...(await scan(kind, tally)));
    console.log(
      `${kind.table}: ${tally.rows} row(s), ${tally.ready} to re-wrap, ${tally.done} already under the new key, ${tally.failed} failed`,
    );
    failed += tally.failed;
  }
  // A row that opens with neither key stops the run before anything is written.
  if (apply && failed === 0 && updates.length > 0) write(updates);
  return { pending: updates.length, failed };
}

const first = await run(!!values.apply);
if (first.failed > 0) process.exit(1);
if (!values.apply) {
  console.log(
    first.pending > 0 ? "Checked only. Run again with --apply to write." : "Nothing to re-wrap.",
  );
  process.exit(0);
}
// Read back: every row must now open with the new key.
const after = await run(false);
if (after.failed > 0 || after.pending > 0) {
  console.error("Some rows still open only with the old key: run again with --apply.");
  process.exit(1);
}
console.log("Every sealed row opens with the new key. Next: remove MASTER_KEY_PREVIOUS.");

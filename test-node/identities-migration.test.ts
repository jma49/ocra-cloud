import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, expect, it } from "vitest";

// Migration 0025 moves GitHub ids out of accounts into identities. It drops
// a column rather than rebuilding the table: with foreign keys on, as on
// D1, dropping accounts would cascade every account's data away.

const MIGRATIONS = "migrations";
const client = createClient({ url: ":memory:" });

async function apply(file: string) {
  const text = await readFile(join(MIGRATIONS, file), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.replace(/^--.*$/gm, "").trim()) await client.execute(statement);
  }
}

beforeAll(async () => {
  await client.execute("PRAGMA foreign_keys = ON");
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.filter((f) => f < "0025")) await apply(file);
  await client.execute(
    "INSERT INTO accounts (id, github_id, login, created_at) VALUES ('a1', 42, 'octo', 1000)",
  );
  await client.execute(
    "INSERT INTO sessions (id, account_id, token_hash, kind, expires_at) VALUES ('s1', 'a1', 'h1', 'web', 9999999999999)",
  );
  for (const file of files.filter((f) => f >= "0025" && f < "0026")) await apply(file);
});

afterAll(() => client.close());

it("gives each account its GitHub identity", async () => {
  const rows = await client.execute(
    "SELECT provider, subject, account_id, created_at FROM identities",
  );
  expect(rows.rows.map((r) => ({ ...r }))).toEqual([
    { provider: "github", subject: "42", account_id: "a1", created_at: 1000 },
  ]);
});

it("keeps every account's data", async () => {
  const sessions = await client.execute("SELECT id FROM sessions");
  expect(sessions.rows.map((r) => r.id)).toEqual(["s1"]);
  const columns = await client.execute("PRAGMA table_info(accounts)");
  expect(columns.rows.map((r) => r.name)).not.toContain("github_id");
});

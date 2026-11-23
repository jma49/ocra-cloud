import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { storedSettings } from "../src/db/server-settings.js";
import { type OpenDatabase, openDatabase } from "../src/node/host.js";
import { loadSettings, saveSettings } from "../src/node/setup/store.js";

// The setup page's saved settings across a master key rotation: a secret
// sealed under the previous key opens, and is sealed again under the current
// one, so it still opens once the previous key is gone.

const keyOf = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const OLD = keyOf(1);
const NEW = keyOf(2);
const dir = mkdtempSync(join(tmpdir(), "ocra-setup-store-"));
let database: OpenDatabase | undefined;
afterAll(() => {
  database?.close();
  rmSync(dir, { recursive: true, force: true });
});

it("seals a secret again under the current key once a rotation starts", async () => {
  database = await openDatabase(`file:${join(dir, "ocra.db")}`, {
    migrations: resolve("migrations"),
    migrate: true,
  });
  const { db } = database;
  const now = new Date();
  await saveSettings(
    db,
    OLD,
    { "models.key": "gw-secret", "models.base": "https://gw.example" },
    now,
  );
  const before = (await storedSettings(db)).find((r) => r.name === "models.key")?.value;

  expect(await loadSettings(db, { current: NEW, previous: OLD })).toEqual({
    "models.key": "gw-secret",
    "models.base": "https://gw.example",
  });
  const after = (await storedSettings(db)).find((r) => r.name === "models.key")?.value;
  expect(after).not.toBe(before);
  expect(after).not.toContain("gw-secret");
  expect((await loadSettings(db, { current: NEW }))["models.key"]).toBe("gw-secret");
});

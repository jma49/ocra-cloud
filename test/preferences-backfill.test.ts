/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import migration from "../migrations/0017_preferences_version.sql?raw";
import { scoped } from "../src/db/scoped.js";
import { DAY } from "../src/time.js";
import { db, resetDb, signIn } from "./helpers.js";

// Migration 0017 gives an existing preferences row its newest saved
// version, so a tab opened before it applies is not refused as stale.

beforeEach(resetDb);

const backfill = migration
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/^--.*$/gm, "").trim())
  .filter((s) => s.startsWith("UPDATE"));

it("sets each row's version to the account's newest saved version", async () => {
  const { account } = await signIn(1, "octo");
  const other = await signIn(2, "other");
  const d = scoped(db, account.id);
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
  await d.insert("preferences", { settings: {} });
  await scoped(db, other.account.id).insert("preferences", { settings: {} });
  for (const [id, n] of [
    ["older", 3],
    ["newest", 1],
  ] as const) {
    await d.insert("preferenceVersions", { id, snapshot: {}, changed: [], createdAt: daysAgo(n) });
  }

  expect(backfill).toHaveLength(1);
  for (const statement of backfill) await env.DB.prepare(statement).run();

  expect((await d.findOne("preferences", {}))?.version).toBe("newest");
  expect((await scoped(db, other.account.id).findOne("preferences", {}))?.version).toBeNull();
});

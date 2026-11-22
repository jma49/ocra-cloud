/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import migration from "../migrations/0047_pull_view_names_hidden.sql?raw";
import { scoped } from "../src/db/scoped.js";
import { db, resetDb, signIn } from "./helpers.js";

// Migration 0047 makes a view's name unique in its account; views that
// already shared one keep it, the later ones with their id's start added.

beforeEach(resetDb);

const statements = migration
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/^--.*$/gm, "").trim());
const rename = statements.filter((s) => s.startsWith("UPDATE"));
const index = statements.filter((s) => s.includes("pull_views_account_name"));

it("renames the later of an account's views that share a name, then indexes the names", async () => {
  const { account } = await signIn(1, "octo");
  const other = await signIn(2, "other");
  await env.DB.prepare("DROP INDEX pull_views_account_name").run();
  const add = (accountId: string, id: string, name: string, at: number) =>
    scoped(db, accountId).insert("pullViews", {
      id,
      name,
      filters: {},
      position: at,
      createdAt: new Date(at),
    });
  await add(account.id, "aaaaaaaa-1", "Mine", 1);
  await add(account.id, "bbbbbbbb-2", "Mine", 2);
  await add(account.id, "cccccccc-3", "Mine", 3);
  await add(other.account.id, "dddddddd-4", "Mine", 4);

  expect(rename).toHaveLength(1);
  expect(index).toHaveLength(1);
  for (const s of [...rename, ...index]) await env.DB.prepare(s).run();

  const names = async (id: string) =>
    (await scoped(db, id).find("pullViews", {})).map((v) => v.name).sort();
  expect(await names(account.id)).toEqual(["Mine", "Mine (bbbbbbbb)", "Mine (cccccccc)"]);
  expect(await names(other.account.id)).toEqual(["Mine"]);
});

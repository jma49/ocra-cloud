/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import migration from "../migrations/0099_finding_threads_addressed.sql?raw";
import { findings } from "../src/db/schema.js";
import { enrolled, FP, PR, thread } from "./finding-events-fakes.js";
import { seed } from "./fix-fakes.js";
import { db, resetDb } from "./helpers.js";

// Migration 0099 makes an open finding whose comment's thread a person
// resolved, before a resolution moved the finding, addressed: one resolved
// on the platform (finding_threads) or from the console (thread_resolved_at).

beforeEach(resetDb);

const backfill = migration
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/^--.*$/gm, "").trim())
  .filter((s) => s.startsWith("UPDATE"));

it("makes an open finding whose thread a person resolved addressed, and only that", async () => {
  const { data } = await enrolled();
  const viaPlatform = await seed(PR, 7, { fingerprint: FP }, "run-1");
  const viaConsole = await seed(PR, 8, { fingerprint: "fedcba9876543210" }, "run-2");
  const untouched = await seed(PR, 9, { fingerprint: "1111111111111111" }, "run-3");
  const dismissed = await seed(PR, 7, { fingerprint: FP }, "run-4");
  await thread("resolved", "2026-11-02T12:00:00Z");
  // As the webhook left them before: the thread resolved, its findings unmarked.
  const unmarked = { decidedAt: null, threadResolvedAt: null };
  await db
    .update(findings)
    .set({ status: "open", ...unmarked })
    .where(eq(findings.id, viaPlatform.id));
  await db
    .update(findings)
    .set({ status: "dismissed", reason: "not_important", ...unmarked })
    .where(eq(findings.id, dismissed.id));
  const fromConsole = new Date("2026-11-02T08:00:00Z");
  await db
    .update(findings)
    .set({ threadResolvedAt: fromConsole })
    .where(eq(findings.id, viaConsole.id));

  expect(backfill).toHaveLength(2);
  for (const statement of backfill) await env.DB.prepare(statement).run();

  const at = new Date("2026-11-02T12:00:00Z");
  expect(await data.get("findings", viaPlatform.id)).toMatchObject({
    status: "addressed",
    decidedAt: at,
    threadResolvedAt: at,
  });
  expect(await data.get("findings", viaConsole.id)).toMatchObject({
    status: "addressed",
    decidedAt: fromConsole,
  });
  expect(await data.get("findings", dismissed.id)).toMatchObject({
    status: "dismissed",
    threadResolvedAt: at,
  });
  expect(await data.get("findings", untouched.id)).toMatchObject({
    status: "open",
    threadResolvedAt: null,
  });
});

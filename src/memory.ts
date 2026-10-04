import { Hono } from "hono";
import { requireSession } from "./auth.js";
import type { AppEnv } from "./types.js";

// Findings the account remembers (ADR-0028, 4). Set from the web; a
// signed-in review fetches its repository's entries.

const MAX_PER_REPO = 500;
const HASH = /^[0-9a-f]{64}$/;

export const memory = new Hono<AppEnv>();

memory.get("/", requireSession(["web", "cli"]), async (c) => {
  const repo = c.req.query("repo");
  const rows = await c.var.data.list("accountMemory");
  const list = repo ? rows.filter((m) => m.repoHash === repo) : rows;
  return c.json({
    entries: list.map(({ accountId: _a, ...m }) => ({ ...m, repo: m.repoHash.slice(0, 8) })),
  });
});

memory.post("/", requireSession(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    findingId?: unknown;
    reason?: unknown;
  } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500 || typeof body?.findingId !== "string") {
    return c.json({ error: "bad_memory" }, 400);
  }
  const finding = await c.var.data.get("findings", body.findingId);
  if (!finding) return c.json({ error: "not_found" }, 404);
  const review = await c.var.data.get("reviews", finding.reviewId);
  if (!review || !HASH.test(review.repoHash)) return c.json({ error: "not_found" }, 404);
  const existing = (await c.var.data.list("accountMemory")).filter(
    (m) => m.repoHash === review.repoHash,
  );
  const same = existing.find((m) => m.fingerprint === finding.fingerprint);
  if (same) return c.json({ id: same.id, duplicate: true });
  if (existing.length >= MAX_PER_REPO)
    return c.json({ error: "memory_full", limit: MAX_PER_REPO }, 409);
  const id = crypto.randomUUID();
  await c.var.data.insert("accountMemory", {
    id,
    repoHash: review.repoHash,
    fingerprint: finding.fingerprint,
    file: finding.file,
    title: finding.title,
    reason,
  });
  return c.json({ id });
});

memory.delete("/:id", requireSession(), async (c) => {
  return c.json({ removed: await c.var.data.remove("accountMemory", c.req.param("id")) });
});

import {
  MAX_MEMORY_PER_REPO,
  type MemoryEntry,
  REPO_HASH,
  rememberRequestSchema,
} from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Findings the account remembers (ADR-0028, 4). Set from the web; a
// signed-in review fetches its repository's entries.

export const memory = new Hono<AppEnv>();

memory.get("/", requireSession(["web", "cli"]), async (c) => {
  const repo = c.req.query("repo");
  const list = await c.var.data.find("accountMemory", repo ? { repoHash: repo } : {});
  return c.json({ entries: list.map(memoryEntryDto) });
});

memory.post("/", requireSession(), jsonBody(rememberRequestSchema), async (c) => {
  const { findingId, reason } = c.req.valid("json");
  const finding = await c.var.data.get("findings", findingId);
  if (!finding) return apiError(c, "not_found");
  const review = await c.var.data.get("reviews", finding.reviewId);
  if (!review || !REPO_HASH.test(review.repoHash)) return apiError(c, "not_found");
  // The duplicate and cap checks are in the insert itself (audit D-hyg).
  const stored = await c.var.data.remember(
    {
      repoHash: review.repoHash,
      fingerprint: finding.fingerprint,
      file: finding.file,
      title: finding.title,
      reason,
    },
    MAX_MEMORY_PER_REPO,
  );
  if (stored === "full") return apiError(c, "memory_full", { limit: MAX_MEMORY_PER_REPO });
  return c.json(stored.duplicate ? { id: stored.id, duplicate: true } : { id: stored.id });
});

memory.delete("/:id", requireSession(), async (c) => {
  return c.json({ removed: await c.var.data.remove("accountMemory", c.req.param("id")) });
});

/** An entry as the contract lists it; the account id stays on the server. */
function memoryEntryDto(m: Row<"accountMemory">) {
  return {
    id: m.id,
    repoHash: m.repoHash,
    repo: m.repoHash.slice(0, 8),
    fingerprint: m.fingerprint,
    file: m.file,
    title: m.title,
    reason: m.reason,
    createdAt: m.createdAt.toISOString(),
  } satisfies MemoryEntry;
}

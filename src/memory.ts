import {
  MAX_MEMORY_PER_REPO,
  type MemoryEntry,
  REPO_HASH,
  rememberRequestSchema,
} from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody, queryLimit } from "./http.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Findings the account remembers (ADR-0028, 4). Set from the web; a
// signed-in review fetches its repository's entries. A list answers at most
// one repository's worth, the newest, so its cost does not grow with the
// account's repositories (#96); `total` says how many there are.

export const memory = new Hono<AppEnv>();

memory.get("/", requireSession(["web", "cli"]), async (c) => {
  const repo = c.req.query("repo");
  const where = repo ? { repoHash: repo } : {};
  const [list, total] = await Promise.all([
    c.var.data.listNewest("accountMemory", queryLimit(c, MAX_MEMORY_PER_REPO), where),
    c.var.data.count("accountMemory", where),
  ]);
  return c.json({ entries: list.map(memoryEntryDto), total });
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

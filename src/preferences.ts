import { Hono } from "hono";
import { requireSession } from "./auth.js";
import type { Scoped } from "./db/scoped.js";
import type { AppEnv } from "./types.js";

// Default models for a review that configures none (ADR-0024 zero
// configuration). The CLI reads them; only the web changes them.

export type ModelChains = { top?: string[]; standard?: string[]; light?: string[] };
const TIERS = ["top", "standard", "light"] as const;

export const preferences = new Hono<AppEnv>();

async function current(data: Scoped) {
  return (await data.list("preferences"))[0];
}

/** Each tier: up to 4 models, each ocra-<provider>/<model>. */
export function parseModels(body: unknown): ModelChains | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ModelChains = {};
  for (const tier of TIERS) {
    const v = b[tier];
    if (v === undefined || v === null) continue;
    const list = (Array.isArray(v) ? v : [v]).filter((m) => m !== "");
    if (list.length > 4) return undefined;
    for (const m of list) {
      if (typeof m !== "string" || !/^ocra-[a-z0-9-]{1,40}\/[\w./:@-]{1,200}$/.test(m))
        return undefined;
    }
    if (list.length > 0) out[tier] = list as string[];
  }
  return out;
}

preferences.get("/models", requireSession(["web", "cli"]), async (c) => {
  return c.json({ models: (await current(c.var.data))?.models ?? {} });
});

preferences.put("/models", requireSession(), async (c) => {
  const models = parseModels(await c.req.json().catch(() => null));
  if (!models) return c.json({ error: "bad_models" }, 400);
  const row = await current(c.var.data);
  if (row) await c.var.data.update("preferences", row.id, { models });
  else await c.var.data.insert("preferences", { id: crypto.randomUUID(), models });
  return c.json({ models });
});

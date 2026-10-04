import { Hono } from "hono";
import { requireSession } from "./auth.js";
import { EFFORTS } from "./capabilities.js";
import type { AgentPrefs, Effort } from "./db/schema.js";
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

const ROLES = ["verifier", "judge", "helper"] as const;
const RUNTIMES = ["direct", "opencode"] as const;
const MODEL = /^ocra-[a-z0-9-]{1,40}\/[\w./:@-]{1,200}$/;
const REVIEWER = /^[a-z][a-z0-9-]{0,39}$/;

function effort(v: unknown): Effort | undefined | false {
  if (v === undefined || v === null || v === "") return undefined;
  return EFFORTS.includes(v as Effort) ? (v as Effort) : false;
}

function chain(v: unknown): string[] | undefined | false {
  if (v === undefined || v === null) return undefined;
  const list = (Array.isArray(v) ? v : [v]).filter((m) => m !== "");
  if (list.length > 4 || list.some((m) => typeof m !== "string" || !MODEL.test(m))) return false;
  return list.length > 0 ? (list as string[]) : undefined;
}

/** The per-agent settings, checked field by field; undefined when any is invalid. */
export function parseAgents(body: unknown): AgentPrefs | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: AgentPrefs = {};
  const tiers = (b.effort ?? {}) as Record<string, unknown>;
  for (const tier of TIERS) {
    const e = effort(tiers[tier]);
    if (e === false) return undefined;
    if (e) out.effort = { ...out.effort, [tier]: e };
  }
  const reviewers = (b.reviewers ?? {}) as Record<string, Record<string, unknown>>;
  const ids = Object.keys(reviewers);
  if (ids.length > 30) return undefined;
  for (const id of ids) {
    if (!REVIEWER.test(id) || (ROLES as readonly string[]).includes(id)) return undefined;
    const r = reviewers[id] ?? {};
    const e = effort(r.effort);
    const m = chain(r.models);
    if (e === false || m === false) return undefined;
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") return undefined;
    const entry = {
      ...(typeof r.enabled === "boolean" ? { enabled: r.enabled } : {}),
      ...(m ? { models: m } : {}),
      ...(e ? { effort: e } : {}),
    };
    if (Object.keys(entry).length > 0) out.reviewers = { ...out.reviewers, [id]: entry };
  }
  const roles = (b.roles ?? {}) as Record<string, Record<string, unknown>>;
  for (const role of Object.keys(roles)) {
    if (!(ROLES as readonly string[]).includes(role)) return undefined;
    const r = roles[role] ?? {};
    const e = effort(r.effort);
    const m = chain(r.models);
    if (e === false || m === false) return undefined;
    const entry = { ...(m ? { models: m } : {}), ...(e ? { effort: e } : {}) };
    if (Object.keys(entry).length > 0) {
      out.roles = { ...out.roles, [role as (typeof ROLES)[number]]: entry };
    }
  }
  return out;
}

// Everything the CLI layers under a repository's configuration.
preferences.get("/", requireSession(["web", "cli"]), async (c) => {
  const row = await current(c.var.data);
  return c.json({
    runtime: row?.runtime ?? null,
    models: row?.models ?? {},
    agents: row?.agents ?? {},
  });
});

preferences.put("/", requireSession(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const models = parseModels(body?.models ?? {});
  const agents = parseAgents(body?.agents ?? {});
  const runtime = body?.runtime ?? null;
  if (!models || !agents || (runtime !== null && !RUNTIMES.includes(runtime as never))) {
    return c.json({ error: "bad_preferences" }, 400);
  }
  const fields = { models, agents, runtime: runtime as (typeof RUNTIMES)[number] | null };
  const row = await current(c.var.data);
  if (row) await c.var.data.update("preferences", row.id, fields);
  else await c.var.data.insert("preferences", { id: crypto.randomUUID(), ...fields });
  return c.json(fields);
});

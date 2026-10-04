import { Hono } from "hono";
import type { AgentPrefs, Effort, ModelChains, ReviewSettings } from "./api-types.js";
import { readJson } from "./body.js";
import { EFFORTS, REVIEWER_ID } from "./contract/index.js";
import type { Scoped } from "./db/scoped.js";
import { hasChatRoute } from "./providers.js";
import { requireSession } from "./session.js";
import { changedKeys, parseSettings } from "./settings.js";
import type { AppEnv } from "./types.js";

// Default models for a review that configures none (ADR-0024 zero
// configuration). The CLI reads them; only the web changes them.

const TIERS = ["top", "standard", "light"] as const;

export const preferences = new Hono<AppEnv>();

async function current(data: Scoped) {
  return (await data.list("preferences"))[0];
}

/** Each tier: up to 4 models, each one usableModel() accepts. */
export function parseModels(body: unknown): ModelChains | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ModelChains = {};
  for (const tier of TIERS) {
    const v = b[tier];
    if (v === undefined || v === null) continue;
    const list = (Array.isArray(v) ? v : [v]).filter((m) => m !== "");
    if (list.length > 4) return undefined;
    for (const m of list) {
      if (!usableModel(m)) return undefined;
    }
    if (list.length > 0) out[tier] = list as string[];
  }
  return out;
}

// The 0.4.0 CLI reads this; saving goes through PUT / (versioned and audited).
preferences.get("/models", requireSession(["web", "cli"]), async (c) => {
  return c.json({ models: (await current(c.var.data))?.models ?? {} });
});

const ROLES = ["verifier", "judge", "helper"] as const;
const RUNTIMES = ["direct", "opencode"] as const;
const MODEL = /^ocra-([a-z0-9-]{1,40})\/[\w./:@-]{1,200}$/;

/**
 * ocra-<provider>/<model>, where the gateway has an OpenAI-compatible chat
 * route for the provider: the CLI can use no other (audit K-models).
 */
export function usableModel(m: unknown): m is string {
  const provider = typeof m === "string" ? MODEL.exec(m)?.[1] : undefined;
  return provider !== undefined && hasChatRoute(provider);
}

function effort(v: unknown): Effort | undefined | false {
  if (v === undefined || v === null || v === "") return undefined;
  return EFFORTS.includes(v as Effort) ? (v as Effort) : false;
}

function chain(v: unknown): string[] | undefined | false {
  if (v === undefined || v === null) return undefined;
  const list = (Array.isArray(v) ? v : [v]).filter((m) => m !== "");
  if (list.length > 4 || list.some((m) => !usableModel(m))) return false;
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
    if (!REVIEWER_ID.test(id) || (ROLES as readonly string[]).includes(id)) return undefined;
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
type Saved = {
  runtime: (typeof RUNTIMES)[number] | null;
  models: ModelChains;
  agents: AgentPrefs;
  settings: ReviewSettings;
};

/** Checks a body against the saved preferences; a part it leaves out keeps its value. */
function parseBody(body: Record<string, unknown> | null, saved: Saved): Saved | undefined {
  const models = body && "models" in body ? parseModels(body.models ?? {}) : saved.models;
  const agents = body && "agents" in body ? parseAgents(body.agents ?? {}) : saved.agents;
  const settings = body && "settings" in body ? parseSettings(body.settings) : saved.settings;
  const runtime = body && "runtime" in body ? (body.runtime ?? null) : saved.runtime;
  if (!models || !agents || !settings) return undefined;
  if (runtime !== null && !RUNTIMES.includes(runtime as never)) return undefined;
  return { models, agents, settings, runtime: runtime as Saved["runtime"] };
}

function savedOf(row: Awaited<ReturnType<typeof current>>): Saved {
  return {
    runtime: row?.runtime ?? null,
    models: row?.models ?? {},
    agents: row?.agents ?? {},
    settings: row?.settings ?? {},
  };
}

const flat = (p: Saved) => ({
  runtime: p.runtime,
  models: p.models,
  agents: p.agents,
  ...p.settings,
});
const KEEP_VERSIONS = 50;

/**
 * Saves the preferences as a new version; returns the version id, or the
 * current one if nothing changed. The update, the version, pruning to the
 * newest KEEP_VERSIONS and the audit event are one D1 batch: all or none.
 */
async function store(
  data: Scoped,
  next: Saved,
): Promise<{ version: string | null; changed: string[] }> {
  const row = await current(data);
  const changed = changedKeys(flat(savedOf(row)), flat(next));
  if (changed.length === 0) return { version: await latestVersion(data), changed };
  const fields = { ...next, updatedAt: new Date() };
  const version = crypto.randomUUID();
  // An upsert on the account: two first saves at once both land, not a 500.
  await data.batch((w) => [
    w.upsert("preferences", { id: crypto.randomUUID(), ...fields }, ["accountId"]),
    w.insert("preferenceVersions", { id: version, snapshot: next, changed }),
    w.keepNewest("preferenceVersions", KEEP_VERSIONS),
    w.insert("auditEvents", {
      id: crypto.randomUUID(),
      kind: "settings.changed",
      detail: { keys: changed, version },
    }),
  ]);
  return { version, changed };
}

async function latestVersion(data: Scoped): Promise<string | null> {
  return (await data.listSince("preferenceVersions", new Date(0), 1))[0]?.id ?? null;
}

preferences.get("/", requireSession(["web", "cli"]), async (c) => {
  const row = await current(c.var.data);
  return c.json({
    ...savedOf(row),
    updatedAt: row?.updatedAt ?? null,
    version: await latestVersion(c.var.data),
  });
});

preferences.put("/", requireSession(), async (c) => {
  const body = (await readJson(c)) as Record<string, unknown> | null;
  const next = parseBody(body, savedOf(await current(c.var.data)));
  if (!next) return c.json({ error: "bad_preferences" }, 400);
  // The web sends the version its draft started from; a save from a stale
  // tab must not overwrite a newer one. A body without it (the CLI) saves.
  if (body && "baseVersion" in body) {
    const latest = await latestVersion(c.var.data);
    if ((body.baseVersion ?? null) !== latest) {
      return c.json({ error: "stale", version: latest }, 409);
    }
  }
  const { version } = await store(c.var.data, next);
  return c.json({ ...next, updatedAt: new Date(), version });
});

preferences.get("/versions", requireSession(), async (c) => {
  const rows = await c.var.data.listSince("preferenceVersions", new Date(0), KEEP_VERSIONS);
  return c.json({
    versions: rows.map((v) => ({ id: v.id, createdAt: v.createdAt, changed: v.changed })),
  });
});

preferences.post("/versions/:id/restore", requireSession(), async (c) => {
  const old = await c.var.data.get("preferenceVersions", c.req.param("id"));
  if (!old) return c.json({ error: "not_found" }, 404);
  // Checked again: a version saved under older rules must still fit today's.
  const next = parseBody(old.snapshot as Record<string, unknown>, savedOf(undefined));
  if (!next) return c.json({ error: "version_no_longer_valid" }, 409);
  const { version } = await store(c.var.data, next);
  return c.json({ ...next, updatedAt: new Date(), version });
});

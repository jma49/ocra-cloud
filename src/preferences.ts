import {
  type AgentPrefs,
  MODEL_TIERS,
  type ModelChains,
  preferencesUpdateSchema,
  type ReviewSettings,
  type Runtime,
} from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import type { z } from "zod";
import { type Catalog, catalogOf } from "./catalog.js";
import { newId, type Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { chatRoute } from "./providers.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { parseModelId } from "./shared/index.js";
import type { AppBindings, AppEnv } from "./types.js";

// Default models for a review that configures none (ADR-0024 zero
// configuration). The CLI reads them; only the web changes them.

export const preferences = new Hono<AppEnv>();

async function current(data: Scoped) {
  return data.findOne("preferences", {});
}

// The 0.4.0 CLI reads this; saving goes through PUT / (versioned and audited).
preferences.get("/models", requireSession(["web", "cli"]), async (c) => {
  return c.json({ models: savedOf(await current(c.var.data), c.env).models });
});

/**
 * The provider of an ocra-<provider>/<model> name the gateway has a chat
 * route for: the CLI can use no other (audit K-models). The contract checks
 * the name's form; only the server knows the routes.
 */
function chatModel(catalog: Catalog, model: string): boolean {
  const ref = parseModelId(model);
  return ref !== null && chatRoute(catalog.get(ref.provider)) !== undefined;
}

/** PUT /api/preferences and a restored version: the contract's shape, and models the gateway can serve. */
export const preferencesBody = (catalog: Catalog) =>
  preferencesUpdateSchema.superRefine((body, ctx) => {
    const chains: [PropertyKey[], readonly string[] | undefined][] = [
      ...Object.entries(body.models ?? {}).map(
        ([tier, chain]) => [["models", tier], chain] as [PropertyKey[], string[]],
      ),
      ...Object.entries(body.agents?.reviewers ?? {}).map(
        ([id, r]) =>
          [["agents", "reviewers", id, "models"], r?.models] as [PropertyKey[], string[]],
      ),
      ...Object.entries(body.agents?.roles ?? {}).map(
        ([role, r]) =>
          [["agents", "roles", role, "models"], r?.models] as [PropertyKey[], string[]],
      ),
    ];
    for (const [path, chain] of chains) {
      for (const [i, model] of (chain ?? []).entries()) {
        if (!chatModel(catalog, model)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, i],
            message: "the gateway has no chat completions or Messages route for this provider",
          });
        }
      }
    }
  });

/**
 * DEFAULT_MODELS: the models an account starts with until it saves its own,
 * as a self-hosted server sets them for everyone (a company's own models).
 * Checked as a save is; throws naming what is wrong, so a server with a
 * broken setting does not start. A review fails on a tier it has no model
 * for, so a tier left out takes the next stronger named tier's models, else
 * the next weaker's.
 */
export function startingModels(env: AppBindings): ModelChains {
  const raw = env.DEFAULT_MODELS;
  if (!raw?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("DEFAULT_MODELS is not JSON");
  }
  const parsed = preferencesBody(catalogOf(env)).safeParse({ models: json });
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.slice(1).join(".")}: ${i.message}`);
    throw new Error(`DEFAULT_MODELS cannot be served (${where.join("; ")})`);
  }
  return everyTier(parsed.data.models ?? {});
}

function everyTier(chains: ModelChains): ModelChains {
  const filled: ModelChains = {};
  for (const [index, tier] of MODEL_TIERS.entries()) {
    const nearest = [
      tier,
      ...MODEL_TIERS.slice(0, index).reverse(),
      ...MODEL_TIERS.slice(index + 1),
    ];
    const chain = nearest.map((named) => chains[named]).find((models) => models?.length);
    if (chain) filled[tier] = chain;
  }
  return filled;
}

// Everything the CLI layers under a repository's configuration.
type Saved = {
  runtime: Runtime | null;
  models: ModelChains;
  agents: AgentPrefs;
  settings: ReviewSettings;
};

/** The saved preferences with a body's parts; a part it leaves out keeps its value, null clears it. */
function merged(body: z.output<ReturnType<typeof preferencesBody>>, saved: Saved): Saved {
  return {
    runtime: body.runtime === undefined ? saved.runtime : body.runtime,
    models: body.models === undefined ? saved.models : (body.models ?? {}),
    agents: body.agents === undefined ? saved.agents : (body.agents ?? {}),
    settings: body.settings === undefined ? saved.settings : (body.settings ?? {}),
  };
}

/** The saved preferences; an account that never saved any starts with the server's models. */
function savedOf(row: Awaited<ReturnType<typeof current>>, env: AppBindings): Saved {
  return {
    runtime: row?.runtime ?? null,
    models: row ? (row.models ?? {}) : startingModels(env),
    agents: row?.agents ?? {},
    settings: row?.settings ?? {},
  };
}

/** The top-level keys whose values differ, for the audit log (never the values). */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

const flat = (p: Saved) => ({
  runtime: p.runtime,
  models: p.models,
  agents: p.agents,
  ...p.settings,
});
const KEEP_VERSIONS = 50;
// A save without a base version (the CLI's) is merged again over a save
// that landed first; past this many it answers stale rather than loop.
const SAVE_ATTEMPTS = 3;

type Stored = { saved: Saved; version: string | null } | { stale: string | null };

/**
 * Saves build's preferences as a new version; returns the saved values and
 * the version id, the current one if nothing changed. With a base version
 * (the web's draft), a save whose base is no longer current is stale; the
 * version check and the write are one compare-and-set in the database, so
 * two saves from the same base cannot both land (audit C6). The row, the
 * version, pruning to the newest KEEP_VERSIONS and the audit event are one
 * D1 batch: all or none.
 */
async function store(
  env: AppBindings,
  data: Scoped,
  base: string | null | undefined,
  build: (saved: Saved) => Saved,
): Promise<Stored> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const row = await current(data);
    const stored = row?.version ?? null;
    if (base !== undefined && base !== stored) return { stale: stored };
    const next = build(savedOf(row, env));
    const changed = changedKeys(flat(savedOf(row, env)), flat(next));
    if (changed.length === 0) return { saved: next, version: stored };
    const version = newId();
    const landed = await data.savePreferences({
      values: next,
      expected: stored,
      version,
      changed,
      keep: KEEP_VERSIONS,
      auditId: newId(),
    });
    if (landed) return { saved: next, version };
  }
  return { stale: (await current(data))?.version ?? null };
}

preferences.get("/", requireSession(["web", "cli"]), async (c) => {
  const row = await current(c.var.data);
  return c.json({
    ...savedOf(row, c.env),
    updatedAt: row?.updatedAt ?? null,
    version: row?.version ?? null,
  });
});

preferences.put(
  "/",
  requireSession(),
  perMinute("settings"),
  jsonBody((c) => preferencesBody(catalogOf(c.env))),
  async (c) => {
    const body = c.req.valid("json");
    // The web sends the version its draft started from; a save from a stale
    // tab must not overwrite a newer one. A body without it (the CLI) saves.
    const result = await store(c.env, c.var.data, body.baseVersion, (saved) => merged(body, saved));
    if ("stale" in result) return apiError(c, "stale", { version: result.stale });
    return c.json({ ...result.saved, updatedAt: new Date(), version: result.version });
  },
);

preferences.get("/versions", requireSession(), async (c) => {
  const rows = await c.var.data.listNewest("preferenceVersions", KEEP_VERSIONS);
  return c.json({
    versions: rows.map((v) => ({ id: v.id, createdAt: v.createdAt, changed: v.changed })),
  });
});

preferences.post("/versions/:id/restore", requireSession(), perMinute("settings"), async (c) => {
  const old = await c.var.data.get("preferenceVersions", c.req.param("id"));
  if (!old) return apiError(c, "not_found");
  // Checked again: a version saved under older rules must still fit today's.
  const parsed = preferencesBody(catalogOf(c.env)).safeParse(old.snapshot);
  if (!parsed.success) return apiError(c, "version_no_longer_valid");
  const result = await store(c.env, c.var.data, undefined, () =>
    merged(parsed.data, savedOf(undefined, c.env)),
  );
  if ("stale" in result) return apiError(c, "stale", { version: result.stale });
  return c.json({ ...result.saved, updatedAt: new Date(), version: result.version });
});

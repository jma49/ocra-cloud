import { Hono } from "hono";
import type { z } from "zod";
import {
  type AgentPrefs,
  CLOUD_PREFIX,
  type ModelChains,
  preferencesUpdateSchema,
  type ReviewSettings,
  type Runtime,
} from "./contract/index.js";
import { newId, type Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { hasChatRoute } from "./providers.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Default models for a review that configures none (ADR-0024 zero
// configuration). The CLI reads them; only the web changes them.

export const preferences = new Hono<AppEnv>();

async function current(data: Scoped) {
  return data.findOne("preferences", {});
}

// The 0.4.0 CLI reads this; saving goes through PUT / (versioned and audited).
preferences.get("/models", requireSession(["web", "cli"]), async (c) => {
  return c.json({ models: (await current(c.var.data))?.models ?? {} });
});

/**
 * The provider of an ocra-<provider>/<model> name the gateway has an
 * OpenAI-compatible chat route for: the CLI can use no other (audit K-models).
 * The contract checks the name's form; only the server knows the routes.
 */
function chatModel(model: string): boolean {
  const provider = model.slice(CLOUD_PREFIX.length, model.indexOf("/"));
  return hasChatRoute(provider);
}

/** PUT /api/preferences and a restored version: the contract's shape, and models the gateway can serve. */
export const preferencesBody = preferencesUpdateSchema.superRefine((body, ctx) => {
  const chains: [PropertyKey[], readonly string[] | undefined][] = [
    ...Object.entries(body.models ?? {}).map(
      ([tier, chain]) => [["models", tier], chain] as [PropertyKey[], string[]],
    ),
    ...Object.entries(body.agents?.reviewers ?? {}).map(
      ([id, r]) => [["agents", "reviewers", id, "models"], r?.models] as [PropertyKey[], string[]],
    ),
    ...Object.entries(body.agents?.roles ?? {}).map(
      ([role, r]) => [["agents", "roles", role, "models"], r?.models] as [PropertyKey[], string[]],
    ),
  ];
  for (const [path, chain] of chains) {
    for (const [i, model] of (chain ?? []).entries()) {
      if (!chatModel(model)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, i],
          message: "the gateway has no OpenAI-compatible chat route for this provider",
        });
      }
    }
  }
});

// Everything the CLI layers under a repository's configuration.
type Saved = {
  runtime: Runtime | null;
  models: ModelChains;
  agents: AgentPrefs;
  settings: ReviewSettings;
};

/** The saved preferences with a body's parts; a part it leaves out keeps its value, null clears it. */
function merged(body: z.output<typeof preferencesBody>, saved: Saved): Saved {
  return {
    runtime: body.runtime === undefined ? saved.runtime : body.runtime,
    models: body.models === undefined ? saved.models : (body.models ?? {}),
    agents: body.agents === undefined ? saved.agents : (body.agents ?? {}),
    settings: body.settings === undefined ? saved.settings : (body.settings ?? {}),
  };
}

function savedOf(row: Awaited<ReturnType<typeof current>>): Saved {
  return {
    runtime: row?.runtime ?? null,
    models: row?.models ?? {},
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
  const version = newId();
  // An upsert on the account: two first saves at once both land, not a 500.
  await data.batch((w) => [
    w.upsert("preferences", fields, ["accountId"]),
    w.insert("preferenceVersions", { id: version, snapshot: next, changed }),
    w.keepNewest("preferenceVersions", KEEP_VERSIONS),
    w.insert("auditEvents", {
      kind: "settings.changed",
      detail: { keys: changed, version },
    }),
  ]);
  return { version, changed };
}

async function latestVersion(data: Scoped): Promise<string | null> {
  return (await data.listNewest("preferenceVersions", 1))[0]?.id ?? null;
}

preferences.get("/", requireSession(["web", "cli"]), async (c) => {
  const row = await current(c.var.data);
  return c.json({
    ...savedOf(row),
    updatedAt: row?.updatedAt ?? null,
    version: await latestVersion(c.var.data),
  });
});

preferences.put("/", requireSession(), jsonBody(preferencesBody), async (c) => {
  const body = c.req.valid("json");
  const next = merged(body, savedOf(await current(c.var.data)));
  // The web sends the version its draft started from; a save from a stale
  // tab must not overwrite a newer one. A body without it (the CLI) saves.
  if (body.baseVersion !== undefined) {
    const latest = await latestVersion(c.var.data);
    if (body.baseVersion !== latest) {
      return apiError(c, "stale", { version: latest });
    }
  }
  const { version } = await store(c.var.data, next);
  return c.json({ ...next, updatedAt: new Date(), version });
});

preferences.get("/versions", requireSession(), async (c) => {
  const rows = await c.var.data.listNewest("preferenceVersions", KEEP_VERSIONS);
  return c.json({
    versions: rows.map((v) => ({ id: v.id, createdAt: v.createdAt, changed: v.changed })),
  });
});

preferences.post("/versions/:id/restore", requireSession(), async (c) => {
  const old = await c.var.data.get("preferenceVersions", c.req.param("id"));
  if (!old) return apiError(c, "not_found");
  // Checked again: a version saved under older rules must still fit today's.
  const parsed = preferencesBody.safeParse(old.snapshot);
  if (!parsed.success) return apiError(c, "version_no_longer_valid");
  const next = merged(parsed.data, savedOf(undefined));
  const { version } = await store(c.var.data, next);
  return c.json({ ...next, updatedAt: new Date(), version });
});

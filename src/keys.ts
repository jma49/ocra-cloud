import { Hono } from "hono";
import { effortLevels } from "./capabilities.js";
import { decryptWithAny, encryptSecret, type MasterKeys } from "./crypto.js";
import type { Effort } from "./db/schema.js";
import type { Scoped } from "./db/scoped.js";
import { applyAuth, isProvider, providers, verifyRoutes } from "./providers.js";
import type { AppEnv } from "./types.js";

// The user's model keys: stored encrypted, one per provider, never returned.

export const keys = new Hono<AppEnv>();

const DAY = 86_400_000;

keys.get("/", async (c) => {
  const rows = await c.var.data.list("providerKeys");
  // One row per provider, summed in SQL (audit D5).
  const now = Date.now();
  const sums = await c.var.data.keyUse(new Date(now - 90 * DAY), new Date(now - 7 * DAY));
  const use = new Map(
    sums.map((u) => [u.provider, { lastUsedAt: new Date(u.lastUsedAt), calls7d: u.recent }]),
  );
  return c.json({
    keys: rows.map((r) => ({
      provider: r.provider,
      last4: r.last4,
      createdAt: r.createdAt,
      checkStatus: r.checkStatus,
      checkedAt: r.checkedAt,
      checkable: isProvider(r.provider) && r.provider in verifyRoutes,
      lastUsedAt: use.get(r.provider)?.lastUsedAt ?? null,
      calls7d: use.get(r.provider)?.calls7d ?? 0,
    })),
  });
});

keys.put("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "unknown_provider" }, 400);
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) {
    return c.json({ error: "bad_key" }, 400);
  }
  const sealed = await encryptSecret(c.env.MASTER_KEY, key);
  const check = await checkKey(provider, key);
  await removeKey(c.var.data, provider);
  await c.var.data.insert("providerKeys", {
    id: crypto.randomUUID(),
    provider,
    ...sealed,
    last4: key.slice(-4),
    checkStatus: check.status,
    checkedAt: new Date(),
  });
  await audit(c.var.data, "key.saved", { provider, check: check.status });
  return c.json({ provider, last4: key.slice(-4), check });
});

keys.post("/:provider/test", async (c) => {
  const provider = c.req.param("provider");
  const row = (await c.var.data.list("providerKeys")).find((r) => r.provider === provider);
  if (!row || !isProvider(provider)) return c.json({ error: "no_key" }, 404);
  const check = await checkKey(provider, await decryptWithAny(masterKeys(c.env), row));
  await c.var.data.update("providerKeys", row.id, {
    checkStatus: check.status,
    checkedAt: new Date(),
  });
  await audit(c.var.data, "key.checked", { provider, check: check.status });
  return c.json({ provider, check });
});

// The models the provider offers this key, for choosing defaults on the web.
keys.get("/:provider/models", async (c) => {
  const provider = c.req.param("provider");
  const row = (await c.var.data.list("providerKeys")).find((r) => r.provider === provider);
  if (!row || !isProvider(provider)) return c.json({ error: "no_key" }, 404);
  const ids = await listModels(provider, await decryptWithAny(masterKeys(c.env), row));
  return c.json({ provider, models: ids });
});

keys.delete("/:provider", async (c) => {
  const provider = c.req.param("provider");
  const removed = await removeKey(c.var.data, provider);
  if (removed) await audit(c.var.data, "key.deleted", { provider });
  return c.json({ removed });
});

export type KeyCheck = {
  status: "ok" | "invalid" | "error" | "unchecked";
  /** The provider's HTTP status, when it answered. */
  httpStatus?: number;
};

/**
 * Asks the provider whether the key works, with a request that costs no
 * tokens. The answer's body is read only to tell a rejected key from another
 * 400, and is never kept or logged.
 */
export async function checkKey(provider: keyof typeof providers, key: string): Promise<KeyCheck> {
  const route = verifyRoutes[provider];
  if (!route) return { status: "unchecked" };
  const headers = new Headers({ accept: "application/json" });
  if (route.auth === "x-api-key") headers.set("anthropic-version", "2023-06-01");
  applyAuth(headers, route.auth, key);
  let res: Response;
  try {
    res = await fetch(providers[provider].base + route.path, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "error" };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) return { status: "ok", httpStatus: res.status };
  if (res.status === 401 || res.status === 403)
    return { status: "invalid", httpStatus: res.status };
  if (res.status === 400 && /api[ _-]?key|token/i.test(text)) {
    return { status: "invalid", httpStatus: res.status };
  }
  return { status: "error", httpStatus: res.status };
}

/**
 * Model ids from the provider's model list: OpenAI-style data[].id, or the
 * Gemini API's models[].name. OpenRouter's list is public and is not its
 * key-checking route. Empty when the provider has no list.
 */
export type ModelInfo = { id: string; efforts: Effort[] };

export async function listModels(
  provider: keyof typeof providers,
  key: string,
): Promise<ModelInfo[]> {
  const route =
    provider === "openrouter"
      ? { path: "/v1/models", auth: "bearer" as const }
      : verifyRoutes[provider]?.path.endsWith("/models")
        ? verifyRoutes[provider]
        : undefined;
  if (!route) return [];
  const headers = new Headers({ accept: "application/json" });
  if (route.auth === "x-api-key") headers.set("anthropic-version", "2023-06-01");
  applyAuth(headers, route.auth, key);
  try {
    const res = await fetch(providers[provider].base + route.path, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: { id?: unknown; supported_parameters?: unknown }[];
      models?: { name?: unknown }[];
    };
    const found = new Map<string, ModelInfo>();
    const add = (id: unknown, live?: { reasoning: boolean }) => {
      if (typeof id !== "string" || !/^[\w./:@-]{1,200}$/.test(id)) return;
      found.set(id, { id, efforts: effortLevels(id, live) });
    };
    for (const m of body.data ?? []) {
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
      add(m.id, params ? { reasoning: params.includes("reasoning") } : undefined);
    }
    for (const m of body.models ?? []) {
      add(typeof m.name === "string" ? m.name.replace(/^models\//, "") : undefined);
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2000);
  } catch {
    return [];
  }
}

async function removeKey(data: Scoped, provider: string): Promise<boolean> {
  let removed = false;
  for (const row of await data.list("providerKeys")) {
    if (row.provider === provider) removed = (await data.remove("providerKeys", row.id)) || removed;
  }
  return removed;
}

export function masterKeys(env: Pick<Env, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">): MasterKeys {
  return { current: env.MASTER_KEY, previous: env.MASTER_KEY_PREVIOUS };
}

/** The account's key for a provider, decrypted, or undefined. */
export async function keyFor(
  data: Scoped,
  keys: MasterKeys,
  provider: string,
): Promise<string | undefined> {
  const row = (await data.list("providerKeys")).find((r) => r.provider === provider);
  return row ? decryptWithAny(keys, row) : undefined;
}

export async function audit(
  data: Scoped,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await data.insert("auditEvents", { id: crypto.randomUUID(), kind, detail });
}

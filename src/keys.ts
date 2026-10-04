import { Hono } from "hono";
import { audit } from "./audit.js";
import { encryptSecret } from "./crypto.js";
import type { Scoped } from "./db/scoped.js";
import { decryptKey, storedKey } from "./keyring.js";
import { checkKey, isProvider, listModels, verifyRoutes } from "./providers.js";
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
  // One statement replaces the provider's key, so parallel saves leave one
  // key, never two for keyFor to choose between.
  const now = new Date();
  await c.var.data.batch((w) => [
    w.upsert(
      "providerKeys",
      {
        id: crypto.randomUUID(),
        provider,
        ...sealed,
        last4: key.slice(-4),
        checkStatus: check.status,
        checkedAt: now,
        createdAt: now,
      },
      ["accountId", "provider"],
    ),
    w.insert("auditEvents", {
      id: crypto.randomUUID(),
      kind: "key.saved",
      detail: { provider, check: check.status },
    }),
  ]);
  return c.json({ provider, last4: key.slice(-4), check });
});

keys.post("/:provider/test", async (c) => {
  const provider = c.req.param("provider");
  const row = await storedKey(c.var.data, provider);
  if (!row || !isProvider(provider)) return c.json({ error: "no_key" }, 404);
  const check = await checkKey(provider, await decryptKey(c.env, row));
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
  const row = await storedKey(c.var.data, provider);
  if (!row || !isProvider(provider)) return c.json({ error: "no_key" }, 404);
  const ids = await listModels(provider, await decryptKey(c.env, row));
  return c.json({ provider, models: ids });
});

keys.delete("/:provider", async (c) => {
  const provider = c.req.param("provider");
  const removed = await removeKey(c.var.data, provider);
  if (removed) await audit(c.var.data, "key.deleted", { provider });
  return c.json({ removed });
});

async function removeKey(data: Scoped, provider: string): Promise<boolean> {
  let removed = false;
  for (const row of await data.list("providerKeys")) {
    if (row.provider === provider) removed = (await data.remove("providerKeys", row.id)) || removed;
  }
  return removed;
}

import { Hono } from "hono";
import { z } from "zod";
import { audit, auditRow } from "./audit.js";
import { catalogOf } from "./catalog.js";
import { config } from "./config.js";
import { encryptSecret, keyBinding } from "./crypto.js";
import type { Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { decryptKey, storedKey } from "./keyring.js";
import { checkKey, listModels } from "./provider-keys.js";
import type { Provider } from "./providers.js";
import { perMinute } from "./rate.js";
import { needsRecentSignIn, requireSession } from "./session.js";
import { DAY } from "./time.js";
import type { AppBindings, AppEnv } from "./types.js";

// The user's model keys: stored encrypted, one per provider, never returned.
// A provider the server holds the key for (MODEL_ENDPOINTS) is listed as
// managed, and takes no key of the user's.

export const keys = new Hono<AppEnv>().use(requireSession());

/** "Calls in the last week" on the keys page. */
const RECENT_DAYS = 7;

keys.get("/", async (c) => {
  const catalog = catalogOf(c.env);
  const managed = catalog.entries.filter(([, p]) => p.sharedKey).map(([name, p]) => ({ name, p }));
  const isManaged = new Set(managed.map((m) => m.name));
  const rows = (await c.var.data.list("providerKeys")).filter((r) => !isManaged.has(r.provider));
  // One row per provider, summed in SQL (audit D5).
  const now = Date.now();
  // Last use is looked for as far back as call records are kept.
  const sums = await c.var.data.keyUse(
    new Date(now - config(c.env).retentionDays * DAY),
    new Date(now - RECENT_DAYS * DAY),
  );
  const use = new Map(
    sums.map((u) => [u.provider, { lastUsedAt: new Date(u.lastUsedAt), calls7d: u.recent }]),
  );
  const used = (provider: string) => ({
    lastUsedAt: use.get(provider)?.lastUsedAt ?? null,
    calls7d: use.get(provider)?.calls7d ?? 0,
  });
  return c.json({
    keys: [
      ...managed.map(({ name, p }) => ({
        provider: name,
        managed: true,
        last4: null,
        createdAt: null,
        checkStatus: null,
        checkedAt: null,
        checkable: p.verify !== undefined,
        ...used(name),
      })),
      ...rows.map((r) => ({
        provider: r.provider,
        managed: false,
        last4: r.last4,
        createdAt: r.createdAt,
        checkStatus: r.checkStatus,
        checkedAt: r.checkedAt,
        checkable: catalog.get(r.provider)?.verify !== undefined,
        ...used(r.provider),
      })),
    ],
  });
});

/** The key a provider's calls use: the server's own, or the account's, decrypted. */
async function usableKey(
  env: AppBindings,
  data: Scoped,
  name: string,
): Promise<{ provider: Provider; key: string; rowId?: string } | undefined> {
  const provider = catalogOf(env).get(name);
  if (!provider) return undefined;
  if (provider.sharedKey) return { provider, key: provider.sharedKey };
  const row = await storedKey(data, name);
  return row ? { provider, key: await decryptKey(env, row), rowId: row.id } : undefined;
}

// A provider's API key, as pasted: surrounding spaces go, inner ones never fit.
const keyRequest = z.object({
  key: z
    .string()
    .transform((k) => k.trim())
    .pipe(z.string().min(8).max(512).regex(/^\S+$/, "a key has no spaces")),
});

keys.put("/:provider", perMinute("keys"), jsonBody(keyRequest), async (c) => {
  const provider = c.req.param("provider");
  const target = catalogOf(c.env).get(provider);
  // A managed provider's calls use the server's key; one of the user's would never be used.
  if (!target || target.sharedKey) return apiError(c, "unknown_provider");
  // A replaced key sends later calls, and what they carry, to its owner.
  if (await storedKey(c.var.data, provider)) {
    const refused = needsRecentSignIn(c);
    if (refused) return refused;
  }
  const { key } = c.req.valid("json");
  const sealed = await encryptSecret(
    c.env.MASTER_KEY,
    key,
    keyBinding(c.var.session.account.id, provider),
  );
  const check = await checkKey(target, key);
  // One statement replaces the provider's key, so parallel saves leave one
  // key, never two for keyFor to choose between.
  const now = new Date();
  await c.var.data.batch((w) => [
    w.upsert(
      "providerKeys",
      {
        provider,
        ...sealed,
        last4: key.slice(-4),
        checkStatus: check.status,
        checkedAt: now,
        createdAt: now,
      },
      ["accountId", "provider"],
    ),
    w.insert("auditEvents", auditRow("key.saved", { provider, check: check.status })),
  ]);
  return c.json({ provider, last4: key.slice(-4), check });
});

keys.post("/:provider/test", perMinute("keys"), async (c) => {
  const provider = c.req.param("provider");
  const found = await usableKey(c.env, c.var.data, provider);
  if (!found) return apiError(c, "no_key");
  const check = await checkKey(found.provider, found.key);
  if (found.rowId) {
    await c.var.data.update("providerKeys", found.rowId, {
      checkStatus: check.status,
      checkedAt: new Date(),
    });
  }
  await audit(c.var.data, "key.checked", { provider, check: check.status });
  return c.json({ provider, check });
});

// The models the provider offers this key, for choosing defaults on the web.
keys.get("/:provider/models", perMinute("keys"), async (c) => {
  const provider = c.req.param("provider");
  const found = await usableKey(c.env, c.var.data, provider);
  if (!found) return apiError(c, "no_key");
  const ids = await listModels(found.provider, found.key);
  return c.json({ provider, models: ids });
});

keys.delete("/:provider", perMinute("settings"), async (c) => {
  const provider = c.req.param("provider");
  const removed = (await c.var.data.removeWhere("providerKeys", { provider })) > 0;
  if (removed) await audit(c.var.data, "key.deleted", { provider });
  return c.json({ removed });
});

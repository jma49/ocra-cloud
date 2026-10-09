import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { encryptSecret, keyBinding } from "./crypto.js";
import { RETENTION_DAYS } from "./db/retention.js";
import { apiError, jsonBody } from "./http.js";
import { decryptKey, storedKey } from "./keyring.js";
import { checkKey, listModels } from "./provider-keys.js";
import { isProvider, providers } from "./providers.js";
import { perMinute } from "./rate.js";
import { needsRecentSignIn, requireSession } from "./session.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// The user's model keys: stored encrypted, one per provider, never returned.

export const keys = new Hono<AppEnv>().use(requireSession());

/** "Calls in the last week" on the keys page. */
const RECENT_DAYS = 7;

keys.get("/", async (c) => {
  const rows = await c.var.data.list("providerKeys");
  // One row per provider, summed in SQL (audit D5).
  const now = Date.now();
  // Last use is looked for as far back as call records are kept.
  const sums = await c.var.data.keyUse(
    new Date(now - RETENTION_DAYS * DAY),
    new Date(now - RECENT_DAYS * DAY),
  );
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
      checkable: isProvider(r.provider) && providers[r.provider].verify !== undefined,
      lastUsedAt: use.get(r.provider)?.lastUsedAt ?? null,
      calls7d: use.get(r.provider)?.calls7d ?? 0,
    })),
  });
});

// A provider's API key, as pasted: surrounding spaces go, inner ones never fit.
const keyRequest = z.object({
  key: z
    .string()
    .transform((k) => k.trim())
    .pipe(z.string().min(8).max(512).regex(/^\S+$/, "a key has no spaces")),
});

keys.put("/:provider", perMinute("keys"), jsonBody(keyRequest), async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return apiError(c, "unknown_provider");
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
  const check = await checkKey(provider, key);
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
    w.insert("auditEvents", {
      kind: "key.saved",
      detail: { provider, check: check.status },
    }),
  ]);
  return c.json({ provider, last4: key.slice(-4), check });
});

keys.post("/:provider/test", perMinute("keys"), async (c) => {
  const provider = c.req.param("provider");
  const row = await storedKey(c.var.data, provider);
  if (!row || !isProvider(provider)) return apiError(c, "no_key");
  const check = await checkKey(provider, await decryptKey(c.env, row));
  await c.var.data.update("providerKeys", row.id, {
    checkStatus: check.status,
    checkedAt: new Date(),
  });
  await audit(c.var.data, "key.checked", { provider, check: check.status });
  return c.json({ provider, check });
});

// The models the provider offers this key, for choosing defaults on the web.
keys.get("/:provider/models", perMinute("keys"), async (c) => {
  const provider = c.req.param("provider");
  const row = await storedKey(c.var.data, provider);
  if (!row || !isProvider(provider)) return apiError(c, "no_key");
  const ids = await listModels(provider, await decryptKey(c.env, row));
  return c.json({ provider, models: ids });
});

keys.delete("/:provider", perMinute("settings"), async (c) => {
  const provider = c.req.param("provider");
  const removed = (await c.var.data.removeWhere("providerKeys", { provider })) > 0;
  if (removed) await audit(c.var.data, "key.deleted", { provider });
  return c.json({ removed });
});

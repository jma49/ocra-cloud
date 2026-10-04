import { Hono } from "hono";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { Scoped } from "./db/scoped.js";
import { isProvider } from "./providers.js";
import type { AppEnv } from "./types.js";

// The user's model keys: stored encrypted, one per provider, never returned.

export const keys = new Hono<AppEnv>();

keys.get("/", async (c) => {
  const rows = await c.var.data.list("providerKeys");
  return c.json({
    keys: rows.map((r) => ({ provider: r.provider, last4: r.last4, createdAt: r.createdAt })),
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
  await removeKey(c.var.data, provider);
  await c.var.data.insert("providerKeys", {
    id: crypto.randomUUID(),
    provider,
    ...sealed,
    last4: key.slice(-4),
  });
  await audit(c.var.data, "key.saved", { provider });
  return c.json({ provider, last4: key.slice(-4) });
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

/** The account's key for a provider, decrypted, or undefined. */
export async function keyFor(
  data: Scoped,
  masterKey: string,
  provider: string,
): Promise<string | undefined> {
  const row = (await data.list("providerKeys")).find((r) => r.provider === provider);
  return row ? decryptSecret(masterKey, row) : undefined;
}

export async function audit(
  data: Scoped,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await data.insert("auditEvents", { id: crypto.randomUUID(), kind, detail });
}

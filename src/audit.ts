import type { Scoped } from "./db/scoped.js";

// The account's audit log: what changed and when, never a key or a body.

export async function audit(
  data: Scoped,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await data.insert("auditEvents", { id: crypto.randomUUID(), kind, detail });
}

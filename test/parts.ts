import { preferencesBody } from "../src/preferences.js";

// One part of a preferences save, checked as PUT /api/preferences checks it:
// what it keeps, or undefined when the save is refused.
export function part(key: "models" | "agents" | "settings", value: unknown): unknown {
  const parsed = preferencesBody.safeParse({ [key]: value });
  return parsed.success ? parsed.data[key] : undefined;
}

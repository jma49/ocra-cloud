import type { ReviewSettings } from "./db/schema.js";

// The review's data settings an account may hold (ADR-0027), checked field
// by field with the configuration file's bounds; the CLI checks them again
// with the configuration's own schema. Never providers, extends or botLogin.

const GLOB = /^[^\n\r\0]{1,300}$/;
// An npm package name, scoped or not; versions are pinned on each machine.
const PACKAGE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const MAX_JSON = 16_384;

type Result = ReviewSettings | undefined;

const int = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v > min && v <= max;

export function parseSettings(body: unknown): Result {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    "concurrency",
    "taskTimeoutMinutes",
    "runTimeoutMinutes",
    "maxCostUsd",
    "maxTasks",
    "verify",
    "judge",
    "sampling",
    "include",
    "exclude",
    "rules",
    "plugins",
    "pluginSettings",
  ]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return undefined;
  const out: ReviewSettings = {};
  const has = (k: string) => b[k] !== undefined && b[k] !== null;

  if (has("concurrency")) {
    if (!int(b.concurrency, 1, 32)) return undefined;
    out.concurrency = b.concurrency as number;
  }
  for (const k of ["taskTimeoutMinutes", "runTimeoutMinutes"] as const) {
    if (!has(k)) continue;
    if (!num(b[k], 0, 600)) return undefined;
    out[k] = b[k] as number;
  }
  if (has("maxCostUsd")) {
    if (!num(b.maxCostUsd, 0, 1000)) return undefined;
    out.maxCostUsd = b.maxCostUsd as number;
  }
  if (has("maxTasks")) {
    if (!int(b.maxTasks, 1, 1000)) return undefined;
    out.maxTasks = b.maxTasks as number;
  }
  for (const k of ["verify", "judge"] as const) {
    if (!has(k)) continue;
    if (typeof b[k] !== "boolean") return undefined;
    out[k] = b[k] as boolean;
  }
  if (has("sampling")) {
    const s = b.sampling as Record<string, unknown>;
    if (typeof s !== "object" || Array.isArray(s)) return undefined;
    if (Object.keys(s).some((k) => k !== "temperature" && k !== "seed")) return undefined;
    const sampling: NonNullable<ReviewSettings["sampling"]> = {};
    if (s.temperature !== undefined) {
      if (typeof s.temperature !== "number" || s.temperature < 0 || s.temperature > 2)
        return undefined;
      sampling.temperature = s.temperature;
    }
    if (s.seed !== undefined) {
      if (!int(s.seed, 0, 2 ** 31 - 1)) return undefined;
      sampling.seed = s.seed as number;
    }
    if (Object.keys(sampling).length > 0) out.sampling = sampling;
  }
  for (const k of ["include", "exclude"] as const) {
    if (!has(k)) continue;
    const list = b[k];
    if (
      !Array.isArray(list) ||
      list.length > 100 ||
      list.some((g) => typeof g !== "string" || !GLOB.test(g))
    ) {
      return undefined;
    }
    if (list.length > 0) out[k] = list as string[];
  }
  if (has("rules")) {
    const rules = b.rules;
    if (!Array.isArray(rules) || rules.length > 50) return undefined;
    const parsed: NonNullable<ReviewSettings["rules"]> = [];
    for (const r of rules as Record<string, unknown>[]) {
      if (
        typeof r !== "object" ||
        r === null ||
        Object.keys(r).some((k) => k !== "path" && k !== "rule")
      ) {
        return undefined;
      }
      const paths = Array.isArray(r.path) ? r.path : [r.path];
      if (
        paths.length === 0 ||
        paths.length > 20 ||
        paths.some((p) => typeof p !== "string" || !GLOB.test(p))
      ) {
        return undefined;
      }
      if (typeof r.rule !== "string" || r.rule.trim().length === 0 || r.rule.length > 2000)
        return undefined;
      parsed.push({
        path: Array.isArray(r.path) ? (paths as string[]) : (paths[0] as string),
        rule: r.rule.trim(),
      });
    }
    if (parsed.length > 0) out.rules = parsed;
  }
  if (has("plugins")) {
    const list = b.plugins;
    if (
      !Array.isArray(list) ||
      list.length > 20 ||
      list.some((p) => typeof p !== "string" || p.length > 214 || !PACKAGE.test(p))
    ) {
      return undefined;
    }
    if (list.length > 0) out.plugins = [...new Set(list as string[])];
  }
  if (has("pluginSettings")) {
    const ps = b.pluginSettings;
    if (typeof ps !== "object" || Array.isArray(ps) || JSON.stringify(ps).length > MAX_JSON)
      return undefined;
    // Only for plugins the account lists (ADR-0027); a repository plugin's
    // settings come from the repository alone.
    const listed = new Set(out.plugins ?? []);
    if (Object.keys(ps as object).some((name) => !listed.has(name))) return undefined;
    if (Object.keys(ps as object).length > 0) out.pluginSettings = ps as Record<string, unknown>;
  }
  return out;
}

/** The top-level keys whose values differ, for the audit log (never the values). */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

import { Hono } from "hono";
import { modelEndpoints } from "./model-endpoints.js";
import { type Provider, providers } from "./providers.js";
import type { AppEnv } from "./types.js";

// The providers this deployment forwards to: the built-in ones, unless
// BUILTIN_PROVIDERS is off (a network that must not reach public model
// APIs), and the server's own MODEL_ENDPOINTS. A name it does not hold is
// refused everywhere a provider is named.

export type CatalogSettings = { MODEL_ENDPOINTS?: string; BUILTIN_PROVIDERS?: string };

export type Catalog = {
  get(name: string): Provider | undefined;
  readonly entries: readonly (readonly [string, Provider])[];
};

const BUILT_IN = new Set(Object.keys(providers));

/** Whether BUILTIN_PROVIDERS keeps the built-in providers: on unless it says off. */
function builtInsOn(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(`BUILTIN_PROVIDERS must be on or off, not ${value}`);
}

function build(env: CatalogSettings): Catalog {
  const own = modelEndpoints(env.MODEL_ENDPOINTS, BUILT_IN);
  const entries = [
    ...(builtInsOn(env.BUILTIN_PROVIDERS) ? Object.entries(providers) : []),
    ...own.entries(),
  ] as const;
  const byName = new Map<string, Provider>(entries);
  return { get: (name) => byName.get(name), entries };
}

// Settings change only with a restart or a deploy; the last one built is kept.
let cached: { key: string; catalog: Catalog } | undefined;

/** The deployment's providers; throws when MODEL_ENDPOINTS or BUILTIN_PROVIDERS is malformed. */
export function catalogOf(env: CatalogSettings): Catalog {
  const key = `${env.BUILTIN_PROVIDERS ?? ""}\0${env.MODEL_ENDPOINTS ?? ""}`;
  if (cached?.key !== key) cached = { key, catalog: build(env) };
  return cached.catalog;
}

/**
 * Whether the provider has an OpenAI-compatible chat route, the one the CLI
 * declares a gateway provider with (packages/cli/src/cloud/providers.ts).
 */
export function hasChatRoute(provider: Provider | undefined): boolean {
  return (
    provider?.routes.some(
      (r) => typeof r.path === "string" && r.path.endsWith("/chat/completions"),
    ) ?? false
  );
}

/**
 * GET /api/providers: the providers and paths the gateway forwards, for the
 * web app and the CLI. It needs no session and changes only with a deploy,
 * so a browser keeps it an hour instead of asking the server on every page
 * (audit C1). A provider whose key the server holds says so; the key never
 * leaves it.
 */
export const providersRoute = new Hono<AppEnv>().get("/", (c) =>
  c.json(
    {
      providers: catalogOf(c.env).entries.map(([name, p]) => ({
        name,
        label: p.label,
        group: p.group,
        base: p.base,
        paths: p.routes.map((r) => (typeof r.path === "string" ? r.path : r.path.source)),
        ...(p.effort ? { effort: p.effort } : {}),
        ...(p.sharedKey ? { managed: true } : {}),
      })),
    },
    200,
    { "cache-control": "public, max-age=3600" },
  ),
);

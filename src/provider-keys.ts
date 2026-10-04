import { effortLevels } from "./capabilities.js";
import type { Effort } from "./db/schema.js";
import { applyAuth, type KeyCall, modelsCall, type ProviderName, providers } from "./providers.js";

// The provider calls the keys routes make with a stored key: checking it,
// and listing the models it reaches. Neither costs tokens.

export type KeyCheck = {
  status: "ok" | "invalid" | "error" | "unchecked";
  /** The provider's HTTP status, when it answered. */
  httpStatus?: number;
};

// Anthropic's API wants its version on every request; its key goes as x-api-key.
const ANTHROPIC_VERSION = "2023-06-01";
/** How long a key check or a model list may take. */
const CHECK_TIMEOUT_MS = 10_000;
/** The most models a list returns. */
const MAX_MODELS = 2000;

/** One GET with the key. A redirect would carry the key to another address: never followed. */
function keyGet(provider: ProviderName, call: KeyCall, key: string): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (call.auth === "x-api-key") headers.set("anthropic-version", ANTHROPIC_VERSION);
  applyAuth(headers, call.auth, key);
  return fetch(providers[provider].base + call.path, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
}

/**
 * Asks the provider whether the key works. The answer's body is read only
 * to tell a rejected key from another 400, and is never kept or logged.
 */
export async function checkKey(provider: ProviderName, key: string): Promise<KeyCheck> {
  const call = providers[provider].verify;
  if (!call) return { status: "unchecked" };
  let res: Response;
  try {
    res = await keyGet(provider, call, key);
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
 * Gemini API's models[].name. Empty when the provider has no list.
 */
export type ModelInfo = { id: string; efforts: Effort[] };

export async function listModels(provider: ProviderName, key: string): Promise<ModelInfo[]> {
  const call = modelsCall(providers[provider]);
  if (!call) return [];
  try {
    const res = await keyGet(provider, call, key);
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
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
  } catch {
    return [];
  }
}

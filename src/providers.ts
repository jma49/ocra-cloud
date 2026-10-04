import type { ProviderGroup } from "./api-types.js";
import { effortLevels } from "./capabilities.js";
import type { ProviderId } from "./contract/index.js";
import type { Effort } from "./db/schema.js";

// The model providers the gateway forwards to, and the only paths it
// forwards for each: exactly the contract's PROVIDER_IDS. A request to any other provider or path is refused.
// Every endpoint here answered 401 or 403 to a request with a wrong key
// (checked 2026-10-04), so it exists and wants a key.

/** How the user's key goes on the upstream request. */
export type AuthStyle =
  | "bearer"
  // Anthropic's own API.
  | "x-api-key"
  // Anthropic-compatible endpoints of other providers: they accept one or
  // the other, so both are sent.
  | "both"
  // The Gemini API's native endpoints.
  | "goog";

export type Route = {
  /** The path after the provider, exactly, or a pattern for paths with a model name. */
  path: string | RegExp;
  auth: AuthStyle;
  /** Query parameters passed upstream; any other is dropped. */
  query?: readonly string[];
};

export type Provider = {
  /** Upstream base URL; the route's path is appended. */
  base: string;
  routes: readonly Route[];
};

const chat = (path = "/v1/chat/completions"): Route => ({ path, auth: "bearer" });
const responses = (path = "/v1/responses"): Route => ({ path, auth: "bearer" });
const messages = (path: string, auth: AuthStyle = "both"): Route => ({ path, auth });
const openaiOnly = (base: string, path?: string): Provider => ({ base, routes: [chat(path)] });

// A Gemini model name in a native path, such as gemini-2.5-flash.
const GEMINI_NATIVE =
  /^\/v1beta\/models\/([A-Za-z0-9._-]{1,100}):(generateContent|streamGenerateContent)$/;

export const providers = {
  openai: { base: "https://api.openai.com", routes: [chat(), responses()] },
  anthropic: {
    base: "https://api.anthropic.com",
    routes: [
      messages("/v1/messages", "x-api-key"),
      messages("/v1/messages/count_tokens", "x-api-key"),
    ],
  },
  openrouter: {
    base: "https://openrouter.ai/api",
    routes: [chat(), responses(), messages("/v1/messages")],
  },
  gemini: {
    base: "https://generativelanguage.googleapis.com",
    routes: [
      chat("/v1beta/openai/chat/completions"),
      { path: GEMINI_NATIVE, auth: "goog", query: ["alt"] },
    ],
  },
  deepseek: {
    base: "https://api.deepseek.com",
    routes: [chat("/chat/completions"), chat(), messages("/anthropic/v1/messages")],
  },
  mistral: openaiOnly("https://api.mistral.ai"),
  groq: { base: "https://api.groq.com/openai", routes: [chat(), responses()] },
  xai: { base: "https://api.x.ai", routes: [chat(), responses(), messages("/v1/messages")] },
  together: openaiOnly("https://api.together.xyz"),
  fireworks: openaiOnly("https://api.fireworks.ai/inference"),
  cerebras: openaiOnly("https://api.cerebras.ai"),
  moonshot: {
    base: "https://api.moonshot.ai",
    routes: [chat(), messages("/anthropic/v1/messages")],
  },
  "moonshot-cn": {
    base: "https://api.moonshot.cn",
    routes: [chat(), messages("/anthropic/v1/messages")],
  },
  "kimi-coding": { base: "https://api.kimi.com/coding", routes: [messages("/v1/messages")] },
  zai: {
    base: "https://api.z.ai/api",
    routes: [
      chat("/paas/v4/chat/completions"),
      chat("/coding/paas/v4/chat/completions"),
      messages("/anthropic/v1/messages"),
    ],
  },
  zhipu: {
    base: "https://open.bigmodel.cn/api",
    routes: [chat("/paas/v4/chat/completions"), messages("/anthropic/v1/messages")],
  },
  qwen: {
    base: "https://dashscope-intl.aliyuncs.com",
    routes: [chat("/compatible-mode/v1/chat/completions"), messages("/apps/anthropic/v1/messages")],
  },
  "qwen-cn": openaiOnly("https://dashscope.aliyuncs.com", "/compatible-mode/v1/chat/completions"),
  minimax: {
    base: "https://api.minimax.io",
    routes: [chat(), messages("/anthropic/v1/messages")],
  },
  "minimax-cn": {
    base: "https://api.minimaxi.com",
    routes: [chat(), messages("/anthropic/v1/messages")],
  },
  siliconflow: openaiOnly("https://api.siliconflow.com"),
  "siliconflow-cn": openaiOnly("https://api.siliconflow.cn"),
  volcengine: openaiOnly("https://ark.cn-beijing.volces.com/api/v3", "/chat/completions"),
  qianfan: openaiOnly("https://qianfan.baidubce.com/v2", "/chat/completions"),
  hunyuan: openaiOnly("https://api.hunyuan.cloud.tencent.com/v1", "/chat/completions"),
  stepfun: openaiOnly("https://api.stepfun.com"),
  baichuan: openaiOnly("https://api.baichuan-ai.com"),
  longcat: openaiOnly("https://api.longcat.chat/openai"),
  huggingface: openaiOnly("https://router.huggingface.co"),
  cohere: openaiOnly("https://api.cohere.ai/compatibility"),
  vercel: openaiOnly("https://ai-gateway.vercel.sh"),
  deepinfra: openaiOnly("https://api.deepinfra.com/v1/openai", "/chat/completions"),
  perplexity: openaiOnly("https://api.perplexity.ai", "/chat/completions"),
  venice: openaiOnly("https://api.venice.ai/api"),
  novita: openaiOnly("https://api.novita.ai/v3/openai", "/chat/completions"),
  nebius: openaiOnly("https://api.studio.nebius.com"),
  sambanova: openaiOnly("https://api.sambanova.ai"),
  "inference-net": openaiOnly("https://api.inference.net"),
  chutes: openaiOnly("https://llm.chutes.ai"),
  upstage: openaiOnly("https://api.upstage.ai"),
  ai21: openaiOnly("https://api.ai21.com/studio"),
  ionos: openaiOnly("https://openai.inference.de-txl.ionos.com"),
  scaleway: openaiOnly("https://api.scaleway.ai"),
  featherless: openaiOnly("https://api.featherless.ai"),
  "opencode-zen": openaiOnly("https://opencode.ai/zen"),
} as const satisfies Record<ProviderId, Provider>;

export type ProviderName = keyof typeof providers;

export function isProvider(name: string): name is ProviderName {
  return Object.hasOwn(providers, name);
}

/**
 * Whether the provider has an OpenAI-compatible chat route, the one the CLI
 * declares a gateway provider with (packages/cli/src/review/cloud-providers.ts).
 */
export function hasChatRoute(name: string): boolean {
  return (
    isProvider(name) &&
    providers[name].routes.some(
      (r) => typeof r.path === "string" && r.path.endsWith("/chat/completions"),
    )
  );
}

export type Match = { route: Route; model: string | null };

/** The route this path takes at this provider, with a model named in the path. */
export function matchRoute(provider: Provider, path: string): Match | undefined {
  for (const route of provider.routes) {
    if (typeof route.path === "string") {
      if (route.path === path) return { route, model: null };
    } else {
      const m = path.match(route.path);
      if (m) return { route, model: m[1] ?? null };
    }
  }
  return undefined;
}

export function applyAuth(headers: Headers, style: AuthStyle, key: string): void {
  if (style === "bearer" || style === "both") headers.set("authorization", `Bearer ${key}`);
  if (style === "x-api-key" || style === "both") headers.set("x-api-key", key);
  if (style === "goog") headers.set("x-goog-api-key", key);
}

/** Request headers passed through as sent, besides content-type and accept. */
export const PASS_HEADERS = ["anthropic-version", "anthropic-beta"] as const;

/**
 * A request that needs a valid key and costs no tokens (most list models),
 * used to check a key when it is saved. Providers whose list answers without
 * a key are missing: their keys cannot be checked in advance.
 */
export const verifyRoutes: Partial<Record<ProviderName, { path: string; auth: AuthStyle }>> = {
  openai: { path: "/v1/models", auth: "bearer" },
  anthropic: { path: "/v1/models", auth: "x-api-key" },
  openrouter: { path: "/v1/key", auth: "bearer" },
  gemini: { path: "/v1beta/models", auth: "goog" },
  deepseek: { path: "/models", auth: "bearer" },
  mistral: { path: "/v1/models", auth: "bearer" },
  groq: { path: "/v1/models", auth: "bearer" },
  xai: { path: "/v1/models", auth: "bearer" },
  together: { path: "/v1/models", auth: "bearer" },
  fireworks: { path: "/v1/models", auth: "bearer" },
  cerebras: { path: "/v1/models", auth: "bearer" },
  moonshot: { path: "/v1/models", auth: "bearer" },
  "moonshot-cn": { path: "/v1/models", auth: "bearer" },
  "kimi-coding": { path: "/v1/models", auth: "both" },
  zai: { path: "/paas/v4/models", auth: "bearer" },
  zhipu: { path: "/paas/v4/models", auth: "bearer" },
  qwen: { path: "/compatible-mode/v1/models", auth: "bearer" },
  "qwen-cn": { path: "/compatible-mode/v1/models", auth: "bearer" },
  minimax: { path: "/v1/models", auth: "bearer" },
  "minimax-cn": { path: "/v1/models", auth: "bearer" },
  siliconflow: { path: "/v1/models", auth: "bearer" },
  "siliconflow-cn": { path: "/v1/models", auth: "bearer" },
  volcengine: { path: "/models", auth: "bearer" },
  hunyuan: { path: "/models", auth: "bearer" },
  stepfun: { path: "/v1/models", auth: "bearer" },
  baichuan: { path: "/v1/models", auth: "bearer" },
  longcat: { path: "/v1/models", auth: "bearer" },
  cohere: { path: "/v1/models", auth: "bearer" },
  vercel: { path: "/v1/models", auth: "bearer" },
  deepinfra: { path: "/models", auth: "bearer" },
  nebius: { path: "/v1/models", auth: "bearer" },
  "inference-net": { path: "/v1/models", auth: "bearer" },
  chutes: { path: "/v1/models", auth: "bearer" },
  upstage: { path: "/v1/models", auth: "bearer" },
  ionos: { path: "/v1/models", auth: "bearer" },
  scaleway: { path: "/v1/models", auth: "bearer" },
  featherless: { path: "/v1/models", auth: "bearer" },
};

/** How the web app shows each provider. */
export const providerInfo: Record<ProviderName, { label: string; group: ProviderGroup }> = {
  openai: { label: "OpenAI", group: "Major" },
  anthropic: { label: "Anthropic", group: "Major" },
  openrouter: { label: "OpenRouter", group: "Major" },
  gemini: { label: "Google Gemini", group: "Major" },
  xai: { label: "xAI", group: "Major" },
  mistral: { label: "Mistral", group: "Major" },
  deepseek: { label: "DeepSeek", group: "Major" },
  groq: { label: "Groq", group: "Platforms" },
  together: { label: "Together AI", group: "Platforms" },
  fireworks: { label: "Fireworks", group: "Platforms" },
  cerebras: { label: "Cerebras", group: "Platforms" },
  moonshot: { label: "Moonshot (Kimi)", group: "China" },
  "moonshot-cn": { label: "Moonshot (Kimi), China", group: "China" },
  "kimi-coding": { label: "Kimi Coding", group: "China" },
  zai: { label: "Z.ai (GLM)", group: "China" },
  zhipu: { label: "Zhipu BigModel, China", group: "China" },
  qwen: { label: "Qwen (DashScope)", group: "China" },
  "qwen-cn": { label: "Qwen (DashScope), China", group: "China" },
  minimax: { label: "MiniMax", group: "China" },
  "minimax-cn": { label: "MiniMax, China", group: "China" },
  siliconflow: { label: "SiliconFlow", group: "China" },
  "siliconflow-cn": { label: "SiliconFlow, China", group: "China" },
  volcengine: { label: "Volcengine Ark", group: "China" },
  qianfan: { label: "Baidu Qianfan", group: "China" },
  hunyuan: { label: "Tencent Hunyuan", group: "China" },
  stepfun: { label: "StepFun", group: "China" },
  baichuan: { label: "Baichuan", group: "China" },
  longcat: { label: "LongCat", group: "China" },
  huggingface: { label: "Hugging Face", group: "Platforms" },
  cohere: { label: "Cohere", group: "Platforms" },
  vercel: { label: "Vercel AI Gateway", group: "Platforms" },
  deepinfra: { label: "DeepInfra", group: "Platforms" },
  perplexity: { label: "Perplexity", group: "Platforms" },
  venice: { label: "Venice", group: "Platforms" },
  novita: { label: "Novita", group: "Platforms" },
  nebius: { label: "Nebius", group: "Platforms" },
  sambanova: { label: "SambaNova", group: "Platforms" },
  "inference-net": { label: "inference.net", group: "Platforms" },
  chutes: { label: "Chutes", group: "Platforms" },
  upstage: { label: "Upstage", group: "Platforms" },
  ai21: { label: "AI21", group: "Platforms" },
  ionos: { label: "IONOS", group: "Platforms" },
  scaleway: { label: "Scaleway", group: "Platforms" },
  featherless: { label: "Featherless", group: "Platforms" },
  "opencode-zen": { label: "OpenCode Zen", group: "Platforms" },
};

// The provider HTTP calls the keys routes make with a stored key.

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
      // A redirect would carry the key to another address: an error instead.
      redirect: "manual",
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
      // A redirect would carry the key to another address: an error instead.
      redirect: "manual",
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

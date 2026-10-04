// The model providers the gateway forwards to, and the only paths it
// forwards for each. A request to any other provider or path is refused.
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
} as const satisfies Record<string, Provider>;

export type ProviderName = keyof typeof providers;

export function isProvider(name: string): name is ProviderName {
  return Object.hasOwn(providers, name);
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

import type { EffortStyle, ProviderId } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import type { ProviderGroup } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The model providers the gateway forwards to, one record each: how the web
// shows it, where it is, the only paths the gateway forwards to it, and how
// a stored key is checked and its models listed. Exactly the contract's
// PROVIDER_IDS. A request to any other provider or path is refused. Every
// endpoint here answered 401 or 403 to a request with a wrong key (checked
// 2026-10-04), so it exists and wants a key.

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

/** A GET the keys routes make with a stored key, never a model call. */
export type KeyCall = { path: string; auth: AuthStyle };

export type Provider = {
  label: string;
  group: ProviderGroup;
  /** Upstream base URL; a route's path is appended. */
  base: string;
  routes: readonly Route[];
  /**
   * A request that needs a valid key and costs no tokens (most list models),
   * to check a key when it is saved. Absent where the list answers without a
   * key: those keys cannot be checked in advance.
   */
  verify?: KeyCall;
  /** The model list, where it is not the verify call (which it is when that ends in /models). */
  models?: KeyCall;
  /** How the CLI's direct runtime sends a reasoning effort; absent, OpenAI's `reasoning_effort`. */
  effort?: EffortStyle;
};

const chat = (path = "/v1/chat/completions"): Route => ({ path, auth: "bearer" });
const responses = (path = "/v1/responses"): Route => ({ path, auth: "bearer" });
const messages = (path: string, auth: AuthStyle = "both"): Route => ({ path, auth });
const openaiOnly = (base: string, path?: string) => ({ base, routes: [chat(path)] });
const keyCall = (path: string, auth: AuthStyle = "bearer"): KeyCall => ({ path, auth });

// A Gemini model name in a native path, such as gemini-2.5-flash.
const GEMINI_NATIVE =
  /^\/v1beta\/models\/([A-Za-z0-9._-]{1,100}):(generateContent|streamGenerateContent)$/;

export const providers: Readonly<Record<ProviderId, Provider>> = {
  openai: {
    label: "OpenAI",
    group: "Major",
    base: "https://api.openai.com",
    routes: [chat(), responses()],
    verify: keyCall("/v1/models"),
  },
  anthropic: {
    label: "Anthropic",
    group: "Major",
    base: "https://api.anthropic.com",
    routes: [
      messages("/v1/messages", "x-api-key"),
      messages("/v1/messages/count_tokens", "x-api-key"),
    ],
    verify: keyCall("/v1/models", "x-api-key"),
  },
  openrouter: {
    label: "OpenRouter",
    group: "Major",
    base: "https://openrouter.ai/api",
    routes: [chat(), responses(), messages("/v1/messages")],
    verify: keyCall("/v1/key"),
    models: keyCall("/v1/models"),
    effort: "openrouter",
  },
  gemini: {
    label: "Google Gemini",
    group: "Major",
    base: "https://generativelanguage.googleapis.com",
    routes: [
      chat("/v1beta/openai/chat/completions"),
      { path: GEMINI_NATIVE, auth: "goog", query: ["alt"] },
    ],
    verify: keyCall("/v1beta/models", "goog"),
  },
  deepseek: {
    label: "DeepSeek",
    group: "Major",
    base: "https://api.deepseek.com",
    routes: [chat("/chat/completions"), chat(), messages("/anthropic/v1/messages")],
    verify: keyCall("/models"),
  },
  mistral: {
    label: "Mistral",
    group: "Major",
    ...openaiOnly("https://api.mistral.ai"),
    verify: keyCall("/v1/models"),
  },
  groq: {
    label: "Groq",
    group: "Platforms",
    base: "https://api.groq.com/openai",
    routes: [chat(), responses()],
    verify: keyCall("/v1/models"),
  },
  xai: {
    label: "xAI",
    group: "Major",
    base: "https://api.x.ai",
    routes: [chat(), responses(), messages("/v1/messages")],
    verify: keyCall("/v1/models"),
  },
  together: {
    label: "Together AI",
    group: "Platforms",
    ...openaiOnly("https://api.together.xyz"),
    verify: keyCall("/v1/models"),
  },
  fireworks: {
    label: "Fireworks",
    group: "Platforms",
    ...openaiOnly("https://api.fireworks.ai/inference"),
    verify: keyCall("/v1/models"),
  },
  cerebras: {
    label: "Cerebras",
    group: "Platforms",
    ...openaiOnly("https://api.cerebras.ai"),
    verify: keyCall("/v1/models"),
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    group: "China",
    base: "https://api.moonshot.ai",
    routes: [chat(), messages("/anthropic/v1/messages")],
    verify: keyCall("/v1/models"),
  },
  "moonshot-cn": {
    label: "Moonshot (Kimi), China",
    group: "China",
    base: "https://api.moonshot.cn",
    routes: [chat(), messages("/anthropic/v1/messages")],
    verify: keyCall("/v1/models"),
  },
  "kimi-coding": {
    label: "Kimi Coding",
    group: "China",
    base: "https://api.kimi.com/coding",
    routes: [messages("/v1/messages")],
    verify: keyCall("/v1/models", "both"),
  },
  zai: {
    label: "Z.ai (GLM)",
    group: "China",
    base: "https://api.z.ai/api",
    routes: [
      chat("/paas/v4/chat/completions"),
      chat("/coding/paas/v4/chat/completions"),
      messages("/anthropic/v1/messages"),
    ],
    verify: keyCall("/paas/v4/models"),
  },
  zhipu: {
    label: "Zhipu BigModel, China",
    group: "China",
    base: "https://open.bigmodel.cn/api",
    routes: [chat("/paas/v4/chat/completions"), messages("/anthropic/v1/messages")],
    verify: keyCall("/paas/v4/models"),
  },
  qwen: {
    label: "Qwen (DashScope)",
    group: "China",
    base: "https://dashscope-intl.aliyuncs.com",
    routes: [chat("/compatible-mode/v1/chat/completions"), messages("/apps/anthropic/v1/messages")],
    verify: keyCall("/compatible-mode/v1/models"),
  },
  "qwen-cn": {
    label: "Qwen (DashScope), China",
    group: "China",
    ...openaiOnly("https://dashscope.aliyuncs.com", "/compatible-mode/v1/chat/completions"),
    verify: keyCall("/compatible-mode/v1/models"),
  },
  minimax: {
    label: "MiniMax",
    group: "China",
    base: "https://api.minimax.io",
    routes: [chat(), messages("/anthropic/v1/messages")],
    verify: keyCall("/v1/models"),
  },
  "minimax-cn": {
    label: "MiniMax, China",
    group: "China",
    base: "https://api.minimaxi.com",
    routes: [chat(), messages("/anthropic/v1/messages")],
    verify: keyCall("/v1/models"),
  },
  siliconflow: {
    label: "SiliconFlow",
    group: "China",
    ...openaiOnly("https://api.siliconflow.com"),
    verify: keyCall("/v1/models"),
  },
  "siliconflow-cn": {
    label: "SiliconFlow, China",
    group: "China",
    ...openaiOnly("https://api.siliconflow.cn"),
    verify: keyCall("/v1/models"),
  },
  volcengine: {
    label: "Volcengine Ark",
    group: "China",
    ...openaiOnly("https://ark.cn-beijing.volces.com/api/v3", "/chat/completions"),
    verify: keyCall("/models"),
  },
  qianfan: {
    label: "Baidu Qianfan",
    group: "China",
    ...openaiOnly("https://qianfan.baidubce.com/v2", "/chat/completions"),
  },
  hunyuan: {
    label: "Tencent Hunyuan",
    group: "China",
    ...openaiOnly("https://api.hunyuan.cloud.tencent.com/v1", "/chat/completions"),
    verify: keyCall("/models"),
  },
  stepfun: {
    label: "StepFun",
    group: "China",
    ...openaiOnly("https://api.stepfun.com"),
    verify: keyCall("/v1/models"),
  },
  baichuan: {
    label: "Baichuan",
    group: "China",
    ...openaiOnly("https://api.baichuan-ai.com"),
    verify: keyCall("/v1/models"),
  },
  longcat: {
    label: "LongCat",
    group: "China",
    ...openaiOnly("https://api.longcat.chat/openai"),
    verify: keyCall("/v1/models"),
  },
  huggingface: {
    label: "Hugging Face",
    group: "Platforms",
    ...openaiOnly("https://router.huggingface.co"),
  },
  cohere: {
    label: "Cohere",
    group: "Platforms",
    ...openaiOnly("https://api.cohere.ai/compatibility"),
    verify: keyCall("/v1/models"),
  },
  vercel: {
    label: "Vercel AI Gateway",
    group: "Platforms",
    ...openaiOnly("https://ai-gateway.vercel.sh"),
    verify: keyCall("/v1/models"),
  },
  deepinfra: {
    label: "DeepInfra",
    group: "Platforms",
    ...openaiOnly("https://api.deepinfra.com/v1/openai", "/chat/completions"),
    verify: keyCall("/models"),
  },
  perplexity: {
    label: "Perplexity",
    group: "Platforms",
    ...openaiOnly("https://api.perplexity.ai", "/chat/completions"),
  },
  venice: { label: "Venice", group: "Platforms", ...openaiOnly("https://api.venice.ai/api") },
  novita: {
    label: "Novita",
    group: "Platforms",
    ...openaiOnly("https://api.novita.ai/v3/openai", "/chat/completions"),
  },
  nebius: {
    label: "Nebius",
    group: "Platforms",
    ...openaiOnly("https://api.studio.nebius.com"),
    verify: keyCall("/v1/models"),
  },
  sambanova: { label: "SambaNova", group: "Platforms", ...openaiOnly("https://api.sambanova.ai") },
  "inference-net": {
    label: "inference.net",
    group: "Platforms",
    ...openaiOnly("https://api.inference.net"),
    verify: keyCall("/v1/models"),
  },
  chutes: {
    label: "Chutes",
    group: "Platforms",
    ...openaiOnly("https://llm.chutes.ai"),
    verify: keyCall("/v1/models"),
  },
  upstage: {
    label: "Upstage",
    group: "Platforms",
    ...openaiOnly("https://api.upstage.ai"),
    verify: keyCall("/v1/models"),
  },
  ai21: { label: "AI21", group: "Platforms", ...openaiOnly("https://api.ai21.com/studio") },
  ionos: {
    label: "IONOS",
    group: "Platforms",
    ...openaiOnly("https://openai.inference.de-txl.ionos.com"),
    verify: keyCall("/v1/models"),
  },
  scaleway: {
    label: "Scaleway",
    group: "Platforms",
    ...openaiOnly("https://api.scaleway.ai"),
    verify: keyCall("/v1/models"),
  },
  featherless: {
    label: "Featherless",
    group: "Platforms",
    ...openaiOnly("https://api.featherless.ai"),
    verify: keyCall("/v1/models"),
  },
  "opencode-zen": {
    label: "OpenCode Zen",
    group: "Platforms",
    ...openaiOnly("https://opencode.ai/zen"),
  },
};

export type ProviderName = ProviderId;

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

/** The model list a stored key can read, if the provider has one. */
export function modelsCall(p: Provider): KeyCall | undefined {
  return p.models ?? (p.verify?.path.endsWith("/models") ? p.verify : undefined);
}

/**
 * GET /api/providers: the providers and paths the gateway forwards, for the
 * web app and the CLI. It needs no session and changes only with a deploy,
 * so a browser keeps it an hour instead of asking the Worker on every page
 * (audit C1).
 */
export const providersRoute = new Hono<AppEnv>().get("/", (c) =>
  c.json(
    {
      providers: Object.entries(providers).map(([name, p]) => ({
        name,
        label: p.label,
        group: p.group,
        base: p.base,
        paths: p.routes.map((r) => (typeof r.path === "string" ? r.path : r.path.source)),
        ...(p.effort ? { effort: p.effort } : {}),
      })),
    },
    200,
    { "cache-control": "public, max-age=3600" },
  ),
);

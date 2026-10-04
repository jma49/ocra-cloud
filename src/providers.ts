// The model providers the gateway forwards to, and the only paths it
// forwards. A request to any other host or path is refused.

export type Provider = {
  /** Upstream base URL; the allowed path is appended. */
  base: string;
  paths: readonly string[];
  /** Puts the user's key on the upstream request. */
  auth: (headers: Headers, key: string) => void;
  /** Request headers passed through as sent (besides content-type and accept). */
  passHeaders: readonly string[];
};

const bearer = (headers: Headers, key: string) => headers.set("authorization", `Bearer ${key}`);

export const providers = {
  openrouter: {
    base: "https://openrouter.ai/api",
    paths: ["/v1/chat/completions"],
    auth: bearer,
    passHeaders: [],
  },
  openai: {
    base: "https://api.openai.com",
    paths: ["/v1/chat/completions", "/v1/responses"],
    auth: bearer,
    passHeaders: [],
  },
  anthropic: {
    base: "https://api.anthropic.com",
    paths: ["/v1/messages"],
    auth: (headers, key) => headers.set("x-api-key", key),
    passHeaders: ["anthropic-version", "anthropic-beta"],
  },
  // The Gemini API's OpenAI-compatible endpoint.
  gemini: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    paths: ["/chat/completions"],
    auth: bearer,
    passHeaders: [],
  },
} as const satisfies Record<string, Provider>;

export type ProviderName = keyof typeof providers;

export function isProvider(name: string): name is ProviderName {
  return Object.hasOwn(providers, name);
}

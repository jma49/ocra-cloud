/** The two wire formats a conversation with a model is held in. */
export type Wire = "openai" | "anthropic";

/**
 * The path a conversation with a provider's models takes, of those the
 * gateway forwards: OpenAI's chat completions where it has them, else
 * Anthropic's Messages. The CLI chooses the same way
 * (packages/cli/src/cloud/providers.ts), so a provider without one can serve
 * neither a review nor the review chat.
 */
export function chatPath(paths: readonly string[]): { path: string; wire: Wire } | undefined {
  const openai = paths.find((path) => path.endsWith("/chat/completions"));
  if (openai) return { path: openai, wire: "openai" };
  const messages = paths.find((path) => path.endsWith("/v1/messages"));
  if (messages) return { path: messages, wire: "anthropic" };
  return undefined;
}

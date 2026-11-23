import { parseUsage, type Usage } from "../gateway.js";
import type { Wire } from "../shared/index.js";

// One streamed model call in the two wire formats the providers speak: an
// OpenAI-compatible chat completion, or Anthropic's messages. Reads the
// answer's text and token counts from the events; never logs either.

export type Turn = { role: "user" | "assistant"; text: string };

/** Anthropic's messages need a cap; the answer is also cut at MAX_ANSWER_CHARS as it streams. */
const MAX_ANSWER_TOKENS = 2_048;

/** The request's body and the headers its format needs. */
export function chatRequest(
  wire: Wire,
  model: string,
  system: string,
  turns: readonly Turn[],
): { body: string; headers: Record<string, string> } {
  const messages = turns.map((t) => ({ role: t.role, content: t.text }));
  if (wire === "anthropic") {
    return {
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: MAX_ANSWER_TOKENS,
        system,
        messages,
      }),
      headers: { "anthropic-version": "2023-06-01" },
    };
  }
  return {
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: system }, ...messages],
    }),
    headers: {},
  };
}

export type ChatEvent = { text: string; usage: Usage; failed: boolean };

/** What one `data:` payload of the stream says; non-JSON payloads (`[DONE]`) say nothing. */
export function chatEvent(wire: Wire, payload: string): ChatEvent {
  const none: ChatEvent = { text: "", usage: { tokensIn: 0, tokensOut: 0 }, failed: false };
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return none;
  }
  if (!json || typeof json !== "object") return none;
  const event = json as Record<string, unknown>;
  const usage = parseUsage(payload);
  if (event.error !== undefined || event.type === "error") return { ...none, usage, failed: true };
  if (wire === "anthropic") {
    const delta = event.delta as { type?: unknown; text?: unknown } | undefined;
    const text =
      event.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
        ? delta.text
        : "";
    return { text, usage, failed: false };
  }
  const choice = (event.choices as { delta?: { content?: unknown } }[] | undefined)?.[0];
  const content = choice?.delta?.content;
  return { text: typeof content === "string" ? content : "", usage, failed: false };
}

/** The `data:` payloads of an event stream, one at a time; null at its end. */
export function ssePayloads(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: string[] = [];
  let finished = false;
  const take = (text: string) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) queue.push(line.slice(5).trim());
  };
  return {
    async next(): Promise<string | null> {
      while (queue.length === 0) {
        if (finished) return null;
        const chunk = await reader.read();
        if (chunk.done) {
          finished = true;
          take(`${decoder.decode()}\n`);
        } else {
          take(decoder.decode(chunk.value, { stream: true }));
        }
      }
      return queue.shift() ?? null;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

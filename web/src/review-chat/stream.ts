import type { ReviewChatEvent, ReviewChatMessageView } from "../../../src/shared/index.js";
import { ApiError } from "../api.js";

/** Why a question was refused: the error, and the provider a missing key is for (null: no model set). */
export class ChatRefusal extends ApiError {
  constructor(
    status: number,
    code: ApiError["code"],
    readonly provider?: string | null,
  ) {
    super(status, code);
  }
}

async function refusal(res: Response): Promise<ChatRefusal> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; provider?: string | null };
  return new ChatRefusal(res.status, body.error as ApiError["code"], body.provider);
}

/**
 * Asks, and hands each piece of the answer to `onText` as it comes
 * (text/event-stream, one JSON event per `data:` line); the stored answer,
 * or throws the refusal.
 */
export async function askReview<M extends ReviewChatMessageView = ReviewChatMessageView>(
  path: string,
  body: { message: string; model?: string },
  onText: (text: string) => void,
): Promise<M> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refusal(res);
  const reader = res.body?.getReader();
  if (!reader) throw new ChatRefusal(502, "upstream_unreachable");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = done ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      if (!block.startsWith("data: ")) continue;
      const event = JSON.parse(block.slice(6)) as ReviewChatEvent;
      if (event.type === "delta") onText(event.text);
      if (event.type === "done") return event.message as M;
      if (event.type === "error") throw new ChatRefusal(502, event.error);
    }
    if (done) throw new ChatRefusal(502, "upstream_unreachable");
  }
}

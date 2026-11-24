import type { Context } from "hono";
import type { Row } from "../db/scoped.js";
import { defer } from "../defer.js";
import { END_STATUS, type Usage } from "../gateway.js";
import type { AppEnv } from "../types.js";
import {
  type ChatModel,
  NO_USAGE,
  recordCall,
  sendChat,
  takeDailyCall,
  tierModels,
  unreachable,
} from "./call.js";
import { chatEvent, ssePayloads, type Turn } from "./model.js";

// An "Ask ocra" answer streamed back as server-sent events, on a review's
// page and a pull request's alike (docs/self-hosting.md, Ask ocra), over
// the console's one model call (./call.ts). The question was kept before;
// the answer is kept after it, and without one the question goes.

export const MAX_QUESTION = 4_000;
/** Earlier messages sent with a question, newest kept. */
export const HISTORY = 20;
/** An answer is cut here as it streams, and the model's stream cancelled. */
const MAX_ANSWER_CHARS = 16_000;

/** The account's standard model, else its top or light one; null with none set. */
export const defaultModel = (prefs: Row<"preferences"> | undefined): string | null =>
  tierModels(prefs)[0] ?? null;

export type ChatAnswer<M> = {
  model: ChatModel;
  system: string;
  turns: Turn[];
  /** When the kept question was asked: its answer is kept after it. */
  asked: Date;
  /** Removes the kept question, which got no answer. */
  unask: () => Promise<unknown>;
  /** Keeps the answer; the message stored, or null when there was no room. */
  keep: (answer: string, at: Date) => Promise<M | null>;
};

type ChatEvent<M> =
  | { type: "delta"; text: string }
  | { type: "done"; message: M }
  | { type: "error"; error: "upstream_unreachable" };

/** Takes the day's call, asks the model and streams its answer. */
export async function streamAnswer<M>(c: Context<AppEnv>, ask: ChatAnswer<M>): Promise<Response> {
  const { model, unask } = ask;
  const limited = await takeDailyCall(c);
  if (limited) {
    await unask();
    return limited;
  }
  const finish = await recordCall(c, model);
  const sent = await sendChat(model, ask.system, ask.turns, c.req.raw.signal);
  if ("status" in sent) {
    defer(c, Promise.all([finish(sent.status, NO_USAGE), unask()]));
    return unreachable(c, sent);
  }

  const payloads = ssePayloads(sent.body);
  const wire = model.route.wire;
  let answer = "";
  const usage: Usage = { ...NO_USAGE };
  let ended = false;
  /** Records the call and keeps the answer so far; without one, the question goes. */
  const end = async (how: "done" | "failed" | "cancelled"): Promise<M | null> => {
    if (ended) return null;
    ended = true;
    await finish(how === "done" ? 200 : END_STATUS[how], usage);
    if (!answer.trim()) {
      await unask();
      return null;
    }
    return ask.keep(answer, new Date(Math.max(Date.now(), ask.asked.getTime() + 1)));
  };
  const enc = new TextEncoder();
  const sse = (e: ChatEvent<M>) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  const failed = () => sse({ type: "error", error: "upstream_unreachable" });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let payload: string | null;
        try {
          payload = await payloads.next();
        } catch {
          await end("failed");
          controller.enqueue(failed());
          controller.close();
          return;
        }
        if (payload === null) {
          const message = await end("done");
          controller.enqueue(message ? sse({ type: "done", message }) : failed());
          controller.close();
          return;
        }
        const event = chatEvent(wire, payload);
        usage.tokensIn = Math.max(usage.tokensIn, event.usage.tokensIn);
        usage.tokensOut = Math.max(usage.tokensOut, event.usage.tokensOut);
        if (event.failed) {
          await payloads.cancel();
          await end("failed");
          controller.enqueue(failed());
          controller.close();
          return;
        }
        if (!event.text) continue;
        const text = event.text.slice(0, MAX_ANSWER_CHARS - answer.length);
        answer += text;
        controller.enqueue(sse({ type: "delta", text }));
        if (answer.length >= MAX_ANSWER_CHARS) {
          await payloads.cancel();
          const message = await end("done");
          if (message) controller.enqueue(sse({ type: "done", message }));
          controller.close();
        }
        return;
      }
    },
    async cancel() {
      defer(c, end("cancelled"));
      await payloads.cancel();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

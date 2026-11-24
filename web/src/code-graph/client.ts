import { type Answers, answer, type LoadEvent, loadGraph, type Request } from "./handlers.js";
import type { Model } from "./model.js";

// The page's side of the explorer's worker: one per open graph. Where the
// browser has no workers (tests), the same answers come from this thread.

export type GraphClient = {
  ask<T extends Request["type"]>(request: Extract<Request, { type: T }>): Promise<Answers[T]>;
  close(): void;
};

type Out = { event: LoadEvent } | { id: number; answer?: unknown; error?: string };

export function openGraph(repo: string, onLoad: (e: LoadEvent) => void): GraphClient {
  if (typeof Worker === "undefined") return inThread(repo, onLoad);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let next = 0;
  worker.onmessage = (e: MessageEvent<Out>) => {
    const msg = e.data;
    if ("event" in msg) return onLoad(msg.event);
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error !== undefined) w?.fail(new Error(msg.error));
    else w?.ok(msg.answer);
  };
  worker.onerror = () => onLoad({ type: "failed", status: 0 });
  worker.postMessage({ type: "load", repo });
  return {
    ask: (request) =>
      new Promise((ok, fail) => {
        const id = next++;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        worker.postMessage({ id, request });
      }),
    close: () => worker.terminate(),
  };
}

function inThread(repo: string, onLoad: (e: LoadEvent) => void): GraphClient {
  const model: Promise<Model | undefined> = loadGraph(repo, onLoad);
  return {
    ask: async (request) => {
      const m = await model;
      if (!m) throw new Error("not loaded");
      return answer(m, request) as never;
    },
    close: () => {},
  };
}

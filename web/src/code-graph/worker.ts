import { answer, loadGraph, type Request } from "./handlers.js";
import type { Model } from "./model.js";

// The explorer's worker: it reads and indexes the graph off the page's
// thread, keeps it, and answers each question with a small object.

type In = { type: "load"; repo: string } | { id: number; request: Request };

let model: Promise<Model | undefined> | undefined;

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  if ("type" in msg) {
    model = loadGraph(msg.repo, (event) => self.postMessage({ event }));
    return;
  }
  const m = await model;
  if (!m) return self.postMessage({ id: msg.id, error: "not loaded" });
  try {
    self.postMessage({ id: msg.id, answer: answer(m, msg.request) });
  } catch (error) {
    self.postMessage({ id: msg.id, error: String(error) });
  }
};

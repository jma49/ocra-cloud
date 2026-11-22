import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Scoped } from "../db/scoped.js";

// A run's events as Server-Sent Events (ADR-0056, 6): what is new since the
// reader's last seq, then storage polled for a while; the stream ends and
// the browser reconnects with Last-Event-ID. Nothing is held between
// requests, so Workers and Node serve it alike.

const POLL_MS = 1_500;
const HOLD_MS = 25_000;
const PAGE = 200;
const RETRY_MS = 1_000;

export function liveStream(c: Context, data: Scoped, liveRunId: string, after: number) {
  return streamSSE(c, async (stream) => {
    const until = Date.now() + HOLD_MS;
    let seq = after;
    await stream.writeSSE({ event: "ready", data: "", retry: RETRY_MS });
    while (!stream.aborted) {
      const rows = await data.live.eventsAfter(liveRunId, seq, PAGE);
      for (const row of rows) {
        await stream.writeSSE({ id: String(row.seq), event: "review", data: JSON.stringify(row) });
        seq = row.seq;
      }
      if (rows.length === PAGE) continue;
      if (rows.length === 0) {
        const run = await data.live.run(liveRunId);
        if (run?.state !== "running") {
          await stream.writeSSE({ event: "end", data: run?.state ?? "gone" });
          return;
        }
      }
      if (Date.now() >= until) return;
      await stream.sleep(POLL_MS);
    }
  });
}

/** Where a reader is: the browser's Last-Event-ID on a reconnect, else `after`. */
export function readerSeq(c: Context): number {
  const last = c.req.header("last-event-id") ?? c.req.query("after");
  const n = Math.trunc(Number(last));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

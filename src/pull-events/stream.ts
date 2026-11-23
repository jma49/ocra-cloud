import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { apiError } from "../http.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { PullsChangedEvent } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { STREAM_MS } from "./hub.js";

// The open inbox's stream of its pull requests' changes (#472), in place of
// asking /pulls/changed every 30 s: Server-Sent Events, a `pulls` event as
// a webhook moves one of the account's enrolled repositories, a comment
// line now and then so proxies keep it open, and an end after a few
// minutes; the browser reconnects, and the console reads /pulls/changed
// once on each `ready`. A web session only: an API token has no console.

/** Under the idle timeouts of proxies on the way (Cloudflare's is 100 s). */
const HEARTBEAT_MS = 25_000;
/** How soon the browser reconnects when a stream ends. */
const RETRY_MS = 3_000;

export const pullEventsRoute = new Hono<AppEnv>();

pullEventsRoute.get("/pulls/changed/stream", requireSession(), perMinute("inbox"), async (c) => {
  const hub = c.var.pullsHub;
  if (!hub) return apiError(c, "not_found");
  const heard: PullsChangedEvent[] = [];
  let wake = () => {};
  const listener = await hub.listen(c.var.session.account.id, (events) => {
    heard.push(...events);
    wake();
  });
  if (listener === "full") {
    c.header("retry-after", "60");
    return apiError(c, "slow_down", {}, 429);
  }
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => listener.close());
    let ended = false;
    listener.closed.then(() => {
      ended = true;
      wake();
    });
    const until = Date.now() + STREAM_MS;
    try {
      await stream.writeSSE({ event: "ready", data: "", retry: RETRY_MS });
      while (!stream.aborted && !ended && Date.now() < until) {
        if (heard.length === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, Math.min(HEARTBEAT_MS, until - Date.now()));
          });
          clearTimeout(timer);
          wake = () => {};
        }
        if (heard.length > 0) {
          await stream.writeSSE({ event: "pulls", data: JSON.stringify(heard.splice(0)) });
        } else if (!ended && Date.now() < until) {
          await stream.write(": \n\n");
        }
      }
    } finally {
      listener.close();
    }
  });
});

import { DurableObject } from "cloudflare:workers";
import type { PullsChangedEvent } from "../shared/index.js";
import { MAX_STREAMS, type PullsHub, type PullsListener, STREAM_MS } from "./hub.js";

// The hub on Workers: one Durable Object per account, holding a WebSocket
// to each Worker request that streams to a console. The object accepts
// them with the hibernation API, so between webhooks it is evicted and
// bills no duration (the Free plan allows 13,000 GB-s a day); a stream
// costs one request to it, a webhook one more.

/** A socket the Worker never closed (its isolate went away) is let go after this. */
const ABANDONED_MS = 2 * STREAM_MS;

type Opened = { at: number };

export class PullEvents extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response(null, { status: 426 });
    const now = Date.now();
    let open = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const opened = ws.deserializeAttachment() as Opened | null;
      if (opened && now - opened.at > ABANDONED_MS) shut(ws);
      else open++;
    }
    if (open >= MAX_STREAMS) return new Response(null, { status: 429 });
    const { 0: worker, 1: own } = new WebSocketPair();
    this.ctx.acceptWebSocket(own);
    own.serializeAttachment({ at: now } satisfies Opened);
    return new Response(null, { status: 101, webSocket: worker });
  }

  publish(events: PullsChangedEvent[]): void {
    const text = JSON.stringify(events);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Closing already: its stream ends and the console reconnects.
      }
    }
  }

  override webSocketClose(ws: WebSocket): void {
    shut(ws);
  }
}

function shut(ws: WebSocket): void {
  try {
    ws.close(1000);
  } catch {
    // Closed already.
  }
}

export function durableHub(ns: DurableObjectNamespace<PullEvents>): PullsHub {
  const of = (accountId: string) => ns.get(ns.idFromName(accountId));
  return {
    async publish(accountId, events) {
      await of(accountId).publish(events);
    },
    async listen(accountId, hear): Promise<PullsListener | "full"> {
      const res = await of(accountId).fetch("https://pull-events/", {
        headers: { upgrade: "websocket" },
      });
      if (res.status === 429) return "full";
      const ws = res.webSocket;
      if (!ws) throw new Error(`pull events answered ${res.status}`);
      ws.accept();
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") hear(JSON.parse(e.data) as PullsChangedEvent[]);
      });
      const closed = new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve());
        ws.addEventListener("error", () => resolve());
      });
      return {
        closed,
        close: () => shut(ws),
      };
    },
  };
}

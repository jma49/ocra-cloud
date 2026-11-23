import type { PullsChangedEvent } from "../shared/index.js";

// Where a webhook or an upload tells an account's open consoles that its
// pull requests changed (#472): a Durable Object per account on Workers
// (./durable.ts), the process's memory on Node, shared by LISTEN/NOTIFY on
// Postgres. It holds nothing: an event no console hears is gone, and a
// console that reconnects reads /pulls/changed once.

/** Streams one account may hold open at once (on Node, per process): a few tabs and windows. */
export const MAX_STREAMS = 6;
/** How long one stream stays open: a signed-out session, or a lost event, outlives it by this at most. */
export const STREAM_MS = 5 * 60_000;

/** One open stream's end of the hub. */
export type PullsListener = {
  /** Settles when the hub let the stream go. */
  closed: Promise<void>;
  close(): void;
};

export type PullsHub = {
  /** Tells the account's open streams; never throws for want of one. */
  publish(accountId: string, events: PullsChangedEvent[]): Promise<void>;
  /** Hands the account's events to `hear` until closed; "full" past MAX_STREAMS. */
  listen(
    accountId: string,
    hear: (events: PullsChangedEvent[]) => void,
  ): Promise<PullsListener | "full">;
};

/**
 * The hub of one Node process. On Postgres the processes share their events
 * (src/node/pull-events-pg.ts); on SQLite or libSQL each has only its own: a
 * console hears the changes its own process received, and the rest when
 * its stream reconnects (src/pull-events/stream.ts).
 */
export function memoryHub(): PullsHub & { endAll(): void } {
  const open = new Map<string, Set<(events: PullsChangedEvent[]) => void>>();
  const ends = new Set<() => void>();
  return {
    endAll() {
      for (const end of [...ends]) end();
    },
    async publish(accountId, events) {
      for (const hear of open.get(accountId) ?? []) hear(events);
    },
    async listen(accountId, hear) {
      const mine = open.get(accountId) ?? new Set();
      if (mine.size >= MAX_STREAMS) return "full";
      const own = (events: PullsChangedEvent[]) => hear(events);
      mine.add(own);
      open.set(accountId, mine);
      let done = () => {};
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const close = () => {
        mine.delete(own);
        if (mine.size === 0 && open.get(accountId) === mine) open.delete(accountId);
        ends.delete(close);
        done();
      };
      ends.add(close);
      return { closed, close };
    },
  };
}

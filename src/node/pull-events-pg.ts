import pg from "pg";
import { z } from "zod";
import { errorName, logError } from "../log.js";
import { memoryHub, type PullsHub } from "../pull-events/hub.js";
import type { PullChangeKind, PullsChangedEvent } from "../shared/index.js";

// The hub of the Node processes sharing one Postgres: a process sends the
// events it publishes with NOTIFY on one channel, and its own connection
// LISTENs there and hands what every process sent to its streams (the
// memory hub). A notice is the account and its small events, never a title
// or body. While that connection is down the process tells its own streams
// only and connects again with backoff; once back it ends its streams,
// whose consoles reconnect and read /pulls/changed for what they missed.

const CHANNEL = "ocra_pulls_changed";
/** Postgres refuses a payload of 8000 bytes or more. */
const MAX_PAYLOAD = 7_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A start waits this long at most for its first LISTEN. */
const CONNECT_MS = 10_000;

const notice = z.object({
  accountId: z.string().min(1).max(64),
  events: z
    .array(
      z.object({
        repoId: z.string().max(64).nullable(),
        number: z.number().int().min(1).nullable(),
        kind: z.enum(["pull", "review", "comment", "checks"] satisfies PullChangeKind[]),
      }),
    )
    .min(1)
    .max(100),
});

export type SharedHub = PullsHub & {
  endAll(): void;
  /** Whether the process hears the others now. */
  listening(): boolean;
  stop(): void;
};

/**
 * The hub over `pool` (NOTIFY) and a connection of its own to `url`
 * (LISTEN); resolves once its first LISTEN succeeded or failed.
 */
export async function postgresHub(
  url: string,
  pool: Pick<pg.Pool, "query">,
  options: { retryMs?: number } = {},
): Promise<SharedHub> {
  const local = memoryHub();
  const first = options.retryMs ?? RETRY_FIRST_MS;
  let delay = first;
  let client: pg.Client | null = null;
  let listening = false;
  let stopped = false;
  let dropped = false;
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const heard = (payload: string | undefined) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? "");
    } catch {
      return;
    }
    const read = notice.safeParse(parsed);
    if (read.success) void local.publish(read.data.accountId, read.data.events);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const own = new pg.Client({
      connectionString: url,
      keepAlive: true,
      connectionTimeoutMillis: CONNECT_MS,
    });
    client = own;
    const lost = (err?: unknown) => {
      if (client !== own) return;
      client = null;
      dropped ||= listening;
      listening = false;
      own.removeAllListeners();
      own.on("error", () => {});
      own.end().catch(() => {});
      if (stopped) return;
      if (!warned) {
        warned = true;
        // The name only: a connection error's message may quote the address.
        logError("pull_events_local_only", { error: errorName(err) });
      }
      timer = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };
    own.on("error", lost);
    own.on("end", () => lost());
    own.on("notification", (n) => {
      if (n.channel === CHANNEL) heard(n.payload);
    });
    try {
      await own.connect();
      await own.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      lost(err);
      return;
    }
    if (client !== own) return;
    listening = true;
    delay = first;
    if (dropped) {
      dropped = false;
      local.endAll();
    }
  };

  await connect();

  return {
    listen: local.listen,
    endAll: local.endAll,
    listening: () => listening,
    async publish(accountId, events) {
      const shared = listening;
      // Unheard by this process's own connection: told here, and still sent to the others.
      if (!shared) await local.publish(accountId, events);
      try {
        for (const payload of payloads(accountId, events)) {
          await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
        }
      } catch (err) {
        if (shared) await local.publish(accountId, events);
        throw err;
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      const own = client;
      client = null;
      listening = false;
      own?.end().catch(() => {});
      local.endAll();
    },
  };
}

/** The account's events as notices of at most MAX_PAYLOAD bytes each. */
function payloads(accountId: string, events: PullsChangedEvent[]): string[] {
  const out: string[] = [];
  let batch: PullsChangedEvent[] = [];
  const text = (list: PullsChangedEvent[]) => JSON.stringify({ accountId, events: list });
  for (const event of events) {
    if (batch.length > 0 && Buffer.byteLength(text([...batch, event])) > MAX_PAYLOAD) {
      out.push(text(batch));
      batch = [];
    }
    batch.push(event);
  }
  if (batch.length > 0) out.push(text(batch));
  return out;
}

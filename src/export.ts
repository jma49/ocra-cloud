import { Hono } from "hono";
import type { Scoped } from "./db/scoped.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

export const exportRoute = new Hono<AppEnv>().use(requireSession());

// Everything stored for the account, as JSON. Keys are listed by provider
// and last four characters; their encrypted values stay on the server. The
// tables are streamed a page at a time (audit D5), so the Worker never holds
// a whole table; each stops at EXPORT_MAX_ROWS, and the tables cut short are
// listed under `truncated`.
const EXPORT_PAGE = 500;
const EXPORT_MAX_ROWS = 250_000;

type Table = Parameters<Scoped["page"]>[0];

/**
 * Every account table, under its key in the export. The type makes a table
 * added to the schema fail to compile until it is listed here (audit
 * S-privacy: the export holds everything stored).
 */
export const EXPORTED = {
  providerKeys: "providerKeys",
  sessions: "sessions",
  preferences: "preferences",
  preferenceVersions: "preferenceVersions",
  reviews: "reviews",
  gatewayCalls: "gatewayCalls",
  auditEvents: "auditEvents",
  findings: "findings",
  accountMemory: "memory",
  usageCounters: "usage",
} as const satisfies Record<Table, string>;

// How a table's row is shown; any other table's row loses only its account id.
const SHAPES: Partial<Record<Table, (row: never) => unknown>> = {
  // Never the encrypted key: provider, last four and when it was checked.
  providerKeys: (k: {
    provider: string;
    last4: string;
    checkStatus: unknown;
    checkedAt: Date | null;
    createdAt: Date;
  }) => ({
    provider: k.provider,
    last4: k.last4,
    checkStatus: k.checkStatus,
    checkedAt: k.checkedAt,
    createdAt: k.createdAt,
  }),
  // Never the token hashes.
  sessions: (s: {
    kind: string;
    label: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date;
    refreshExpiresAt: Date | null;
  }) => ({
    kind: s.kind,
    label: s.label,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.refreshExpiresAt ?? s.expiresAt,
  }),
};

exportRoute.get("/", (c) => {
  const d = c.var.data;
  const { account: a } = c.var.session;
  const tables = Object.entries(EXPORTED).map(
    ([table, key]) => [key, table as Table, SHAPES[table as Table] ?? strip] as const,
  );
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(out) {
      const put = (text: string) => out.enqueue(enc.encode(text));
      try {
        put(`{"exportedAt":${JSON.stringify(new Date())}`);
        put(
          `,"account":${JSON.stringify({
            login: a.login,
            githubId: a.githubId,
            createdAt: a.createdAt,
            shareFindings: a.shareFindings,
            // The repository-hash salt, held once findings were shared (null before).
            salt: a.salt,
          })}`,
        );
        const truncated: string[] = [];
        for (const [key, table, shape] of tables) {
          put(`,${JSON.stringify(key)}:[`);
          let after = 0;
          let written = 0;
          for (;;) {
            const page = await d.page(table, after, EXPORT_PAGE);
            for (const row of page.rows) {
              if (written >= EXPORT_MAX_ROWS) break;
              put(`${written > 0 ? "," : ""}${JSON.stringify(shape(row as never))}`);
              written++;
            }
            if (page.next === null) break;
            if (written >= EXPORT_MAX_ROWS) {
              truncated.push(key);
              break;
            }
            after = page.next;
          }
          put("]");
        }
        if (truncated.length > 0) put(`,"truncated":${JSON.stringify(truncated)}`);
        put("}");
        out.close();
      } catch (e) {
        out.error(e);
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="ocra-cloud-export.json"',
    },
  });
});

function strip<T extends { accountId: string }>({ accountId: _a, ...r }: T) {
  return r;
}

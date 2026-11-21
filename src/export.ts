import { Hono } from "hono";
import type { SessionAccount } from "./db/accounts.js";
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
  repositories: "repositories",
  budgets: "budgets",
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
  const chunks = exportChunks(c.var.data, c.var.session.account);
  const enc = new TextEncoder();
  // One chunk per pull, so a page is read only once the client has taken
  // the last (audit C9); a slow client never makes the Worker queue tables.
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      const next = await chunks.next();
      if (next.done) out.close();
      else out.enqueue(enc.encode(next.value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="ocra-cloud-export.json"',
    },
  });
});

type Account = SessionAccount["account"];

/** The export's JSON text: the account, then each table a page at a time. */
async function* exportChunks(d: Scoped, a: Account): AsyncGenerator<string, void> {
  yield `{"exportedAt":${JSON.stringify(new Date())},"account":${JSON.stringify({
    login: a.login,
    githubId: a.githubId,
    createdAt: a.createdAt,
    shareFindings: a.shareFindings,
    // The repository-hash salt, held once findings were shared (null before).
    salt: a.salt,
  })}`;
  const truncated: string[] = [];
  for (const [table, key] of Object.entries(EXPORTED) as [Table, string][]) {
    const shape = SHAPES[table] ?? strip;
    let text = `,${JSON.stringify(key)}:[`;
    let after = 0;
    let written = 0;
    for (;;) {
      const page = await d.page(table, after, EXPORT_PAGE);
      for (const row of page.rows) {
        if (written >= EXPORT_MAX_ROWS) break;
        text += `${written > 0 ? "," : ""}${JSON.stringify(shape(row as never))}`;
        written++;
      }
      if (page.next !== null && written >= EXPORT_MAX_ROWS) truncated.push(key);
      if (page.next === null || written >= EXPORT_MAX_ROWS) break;
      after = page.next;
      yield text;
      text = "";
    }
    yield `${text}]`;
  }
  yield `${truncated.length > 0 ? `,"truncated":${JSON.stringify(truncated)}` : ""}}`;
}

function strip<T extends { accountId: string }>({ accountId: _a, ...r }: T) {
  return r;
}

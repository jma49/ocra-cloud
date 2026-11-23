import { Hono } from "hono";
import { githubIdOf, type SessionAccount } from "./db/accounts.js";
import type { PageKey, Scoped } from "./db/scoped.js";
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
  apiTokens: "apiTokens",
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
  platformLinks: "platforms",
  pullViews: "pullViews",
  pullSeen: "pullSeen",
  pullFileViews: "pullFileViews",
  graphRepos: "graphRepos",
  graphBuilds: "graphBuilds",
  reviewRepos: "reviewRepos",
  reviewJobs: "reviewJobs",
  notifyChannels: "notifyChannels",
  notifySends: "notifySends",
  notifyHeld: "notifyHeld",
  notifyDeliveries: "notifyDeliveries",
  closedPulls: "closedPulls",
  pullFlows: "pullFlows",
  pullReviews: "pullReviews",
  reviewThreads: "reviewThreads",
  pullPaths: "pullPaths",
  reviewRequests: "reviewRequests",
  reviewTargets: "reviewTargets",
  replyJobs: "replyJobs",
  reviewWalkthroughs: "walkthroughs",
  generateJobs: "generateJobs",
  automationRules: "automationRules",
  automationRuns: "automationRuns",
  automationAssignments: "automationAssignments",
  mergeChecks: "mergeChecks",
  mergeCheckRuns: "mergeCheckRuns",
  mergeIntents: "mergeIntents",
  reviewChatMessages: "reviewChat",
  findingIssues: "findingIssues",
  liveRuns: "liveRuns",
  liveEvents: "liveEvents",
  liveGrants: "liveGrants",
  liveComments: "liveComments",
} as const satisfies Record<Table, string>;

// How a table's row is shown; any other table's row loses only its account id.
const SHAPES: Partial<Record<Table, (row: never) => unknown>> = {
  // Never the token: only that one is held, and until when.
  platformLinks: (g: {
    platform: string;
    host: string;
    userId: string | null;
    login: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
    createdAt: Date;
  }) => ({
    platform: g.platform,
    host: g.host,
    userId: g.userId,
    login: g.login,
    accessExpiresAt: g.accessExpiresAt,
    refreshExpiresAt: g.refreshExpiresAt,
    createdAt: g.createdAt,
  }),
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
  // Never the hook secret's hash.
  graphRepos: ({ webhookSecretHash: _hash, accountId: _account, ...r }: Record<string, unknown>) =>
    r,
  reviewRepos: ({ webhookSecretHash: _hash, accountId: _account, ...r }: Record<string, unknown>) =>
    r,
  // Never the webhook or email address, nor a confirmation token's hash.
  notifyChannels: ({
    wrappedKey: _w,
    ciphertext: _c,
    confirmTokenHash: _t,
    accountId: _account,
    ...n
  }: Record<string, unknown>) => n,
  // Never the share link's nonce, which with the server's secret makes the link.
  liveRuns: ({ linkNonce: _n, accountId: _account, ...r }: Record<string, unknown>) => r,
  // The graph itself is served by GET /api/graphs/repos/:id/graph.
  graphBuilds: ({ content: _content, accountId: _account, ...b }: Record<string, unknown>) => b,
  // Never the secret's hash.
  apiTokens: ({ tokenHash: _hash, accountId: _account, ...t }: Record<string, unknown>) => t,
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
  const { account } = c.var.session;
  const chunks = exportChunks(c.var.data, account, () => githubIdOf(c.var.db, account.id));
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
async function* exportChunks(
  d: Scoped,
  a: Account,
  githubId: () => Promise<number | null>,
): AsyncGenerator<string, void> {
  yield `{"exportedAt":${JSON.stringify(new Date())},"account":${JSON.stringify({
    login: a.login,
    githubId: await githubId(),
    createdAt: a.createdAt,
    shareFindings: a.shareFindings,
    // The repository-hash salt, held once findings were shared (null before).
    salt: a.salt,
    inboxSince: a.inboxSince,
    timeZone: a.timeZone,
    digestDay: a.digestDay,
    reportWeekday: a.reportWeekday,
    reportHour: a.reportHour,
    reportSentFor: a.reportSentFor,
  })}`;
  const truncated: string[] = [];
  for (const [table, key] of Object.entries(EXPORTED) as [Table, string][]) {
    const shape = SHAPES[table] ?? strip;
    let text = `,${JSON.stringify(key)}:[`;
    let after: PageKey | null = null;
    let written = 0;
    for (;;) {
      const page: Awaited<ReturnType<Scoped["page"]>> = await d.page(table, after, EXPORT_PAGE);
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

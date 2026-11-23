import { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.js";
import { randomToken, sha256Hex } from "./crypto.js";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { needsRecentSignIn, requireSession } from "./session.js";
import {
  API_TOKEN_MAX,
  API_TOKEN_MAX_DAYS,
  API_TOKEN_NAME_MAX,
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  type ApiTokenCreated,
  type ApiTokenDraft,
  type ApiTokenView,
} from "./shared/index.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// Making, listing and revoking personal API tokens: from the web console
// only, never with a token or the CLI. The secret is answered once, when the
// token is made; only its SHA-256 is stored.

export const apiTokensRoute = new Hono<AppEnv>().use(requireSession(["web"]));

/** Characters of the secret after API_TOKEN_PREFIX shown in the list: 36 of its 256 bits. */
const SHOWN = 6;

const draft = z
  .object({
    name: z.string().trim().min(1).max(API_TOKEN_NAME_MAX),
    scopes: z
      .array(z.enum(API_TOKEN_SCOPES))
      .min(1)
      .max(API_TOKEN_SCOPES.length)
      .transform((s) => [...new Set(s)]),
    expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS),
  })
  .strict();

function tokenDto(t: Row<"apiTokens">): ApiTokenView {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    prefix: t.prefix,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt.toISOString(),
  } satisfies ApiTokenView;
}

apiTokensRoute.get("/", async (c) => {
  const rows = await c.var.data.apiTokens.live(new Date());
  return c.json({ tokens: rows.map(tokenDto) });
});

// A stolen or forgotten browser session must not mint a credential that
// outlives it, so making one needs a recent sign-in.
apiTokensRoute.post("/", perMinute("settings"), jsonBody(draft), async (c) => {
  const refused = needsRecentSignIn(c);
  if (refused) return refused;
  const { name, scopes, expiresInDays }: ApiTokenDraft = c.req.valid("json");
  const secret = randomToken(API_TOKEN_PREFIX);
  const id = crypto.randomUUID();
  const prefix = secret.slice(0, API_TOKEN_PREFIX.length + SHOWN);
  const expiresAt = new Date(Date.now() + expiresInDays * DAY);
  const tokenHash = await sha256Hex(secret);
  const added = await c.var.data.apiTokens.add(
    { id, name, tokenHash, prefix, scopes, expiresAt },
    API_TOKEN_MAX,
  );
  if (!added) {
    return apiError(c, "invalid_body", {
      issues: [{ path: [], message: `at most ${API_TOKEN_MAX} tokens` }],
    });
  }
  await audit(c.var.data, "token.created", {
    prefix,
    scopes,
    expiresAt: expiresAt.toISOString(),
  });
  const row = await c.var.data.findOne("apiTokens", { id });
  if (!row) return apiError(c, "not_found");
  return c.json({ token: tokenDto(row), secret } satisfies ApiTokenCreated, 201);
});

apiTokensRoute.delete("/:id", async (c) => {
  const row = await c.var.data.findOne("apiTokens", { id: c.req.param("id") });
  const removed = row ? await c.var.data.remove("apiTokens", row.id) : false;
  if (row && removed) await audit(c.var.data, "token.revoked", { prefix: row.prefix });
  return c.json({ removed });
});

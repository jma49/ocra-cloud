// Personal API tokens: what a script or CI job may read with one. A token
// reaches only the routes listed in API_TOKEN_ROUTES, each with one scope,
// and only to read; it never manages tokens, keys, channels, sessions or the
// account.

export const API_TOKEN_SCOPES = ["reviews:read", "insights:read", "pulls:read"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** How every token starts, so a leaked one is recognised by scanners and by eye. */
export const API_TOKEN_PREFIX = "ocra_pat_";
/** A token lives at most this long; its expiry is chosen when it is made. */
export const API_TOKEN_MAX_DAYS = 365;
/** Tokens an account may hold at once. */
export const API_TOKEN_MAX = 20;
export const API_TOKEN_NAME_MAX = 64;

/** Each route a token may call, by "METHOD /path" as registered, and the scope it needs. */
export const API_TOKEN_ROUTES: Readonly<Record<string, ApiTokenScope>> = {
  "GET /api/reviews": "reviews:read",
  "GET /api/reviews/:id": "reviews:read",
  "GET /api/insights/cycle": "insights:read",
  "GET /api/insights/flow": "insights:read",
  "GET /api/insights/impact": "insights:read",
  "GET /api/insights/reviewers": "insights:read",
  "GET /api/findings/insights": "insights:read",
  "GET /api/platforms/pulls": "pulls:read",
  "GET /api/pulls/files": "pulls:read",
  "GET /api/pulls/threads": "pulls:read",
  "GET /api/pulls/readiness": "pulls:read",
};

/** A token as GET /api/tokens lists it: never its secret, only the start shown with it. */
export type ApiTokenView = {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  /** The token's first characters, to tell it apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

/** POST /api/tokens: the new token and its secret, shown this once. */
export type ApiTokenCreated = { token: ApiTokenView; secret: string };

/** POST /api/tokens's body. */
export type ApiTokenDraft = { name: string; scopes: ApiTokenScope[]; expiresInDays: number };

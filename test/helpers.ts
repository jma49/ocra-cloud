import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import app from "../src/index.js";
import { startCliSession, startWebSession } from "../src/session.js";

export const db = drizzle(env.DB);
export const ORIGIN = "https://ocra.test";

export type CallInit = RequestInit & {
  /** Sent as the JSON body, with its content type. */
  json?: unknown;
  /** A signed-in account's headers (`signIn(...).auth`). */
  auth?: Record<string, string>;
};

/** The content type of a JSON body sent as a string. */
export const JSON_TYPE = { "content-type": "application/json" };

/** A request to the app; `headers` are applied last, over `auth` and `json`'s content type. */
export function request(path: string, init: CallInit = {}): Request {
  const { json, auth, headers, ...rest } = init;
  const sent = new Headers(auth);
  if (json !== undefined) sent.set("content-type", JSON_TYPE["content-type"]);
  new Headers(headers).forEach((value, name) => {
    sent.set(name, value);
  });
  return new Request(ORIGIN + path, {
    ...rest,
    headers: sent,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}

/** Calls the app in this isolate, so a spy on fetch sees its upstream calls. */
export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), env, ctx);
  // Read the body before waiting, so the stream's flush (and its record) runs.
  const body = await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(res.status === 204 || res.status === 304 ? null : body, {
    status: res.status,
    headers: res.headers,
  });
}

export async function resetDb(): Promise<void> {
  await db.delete(schema.accounts);
}

/** A signed-in account and its web session token, sent as a bearer token. */
export async function signIn(githubId: number, login: string) {
  const account = await upsertAccount(db, githubId, login);
  const token = await startWebSession(db, account.id);
  return { account, token, auth: { authorization: `Bearer ${token}` } };
}

/** A signed-in account with a CLI session, as `ocra login` leaves it. */
export async function signInCli(githubId: number, login: string) {
  const account = await upsertAccount(db, githubId, login);
  const tokens = await startCliSession(db, account.id, "test terminal");
  return { account, tokens, auth: { authorization: `Bearer ${tokens.access_token}` } };
}

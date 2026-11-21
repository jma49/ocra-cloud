import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { randomToken } from "./crypto.js";
import { apiError } from "./http.js";
import { gitlab, gitlabToken } from "./platforms/gitlab.js";
import { saveToken } from "./platforms/links.js";
import { gitlabCallback, gitlabClientOf } from "./platforms/registry.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { AppEnv } from "./types.js";

// Connecting a code platform other than the one people sign in with: the
// signed-in user is sent to GitLab's OAuth consent, and its answer is kept
// as their link there. The state is signed and names the account, so a
// callback finishes only for the account that started it.

export const platformConnect = new Hono<AppEnv>();

const STATE_COOKIE = "__Host-ocra_gitlab_state";
const STATE_OPTIONS = { secure: true, path: "/" } as const;
/** What the token can do: read the user's projects and nothing else. */
const SCOPE = "read_api";

platformConnect.get("/gitlab/connect", requireSession(), perMinute("settings"), async (c) => {
  const client = gitlabClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const state = randomToken("");
  await setSignedCookie(
    c,
    STATE_COOKIE,
    `${state} ${c.var.session.account.id}`,
    c.env.SESSION_SECRET,
    { httpOnly: true, sameSite: "Lax", maxAge: 600, ...STATE_OPTIONS },
  );
  const url = new URL(`${client.url}/oauth/authorize`);
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", gitlabCallback(c.req.url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPE);
  return c.redirect(url.toString(), 302);
});

platformConnect.get("/gitlab/callback", requireSession(), async (c) => {
  const client = gitlabClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const cookie = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, STATE_OPTIONS);
  const [expected, accountId] = (cookie || "").split(" ");
  const { code, state } = c.req.query();
  if (!code || !state || state !== expected || accountId !== c.var.session.account.id) {
    return apiError(c, "bad_state");
  }
  const redirectUri = gitlabCallback(c.req.url);
  const answer = await gitlabToken(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  if (!answer?.access_token) return apiError(c, "upstream_unreachable");
  await saveToken(c.var.data, c.env, gitlab(client, redirectUri), answer);
  return c.redirect("/repositories", 302);
});

import { type Dispatcher, fetch } from "undici";
import { appJwt } from "../../platforms/bot-tokens.js";
import { githubHost } from "../../platforms/github-host.js";
import type { AuthStyle } from "../../providers.js";
import type { SetupCheck } from "../../shared/index.js";
import type { Settings } from "./settings.js";

// The setup page's connection tests: each says in plain words what it
// reached and, when something failed, what to change. They fetch through
// the network the page is about to save (./network.ts), not yet the
// process's own.

export type Check = SetupCheck;

const TIMEOUT_MS = 10_000;

type Answer = { status: number; json: unknown };
type Reached = { ok: true; answer: Answer } | { ok: false; check: Check };

async function reach(
  title: string,
  url: string,
  dispatcher: Dispatcher,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reached> {
  try {
    const res = await fetch(url, {
      ...init,
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { ok: true, answer: { status: res.status, json } };
  } catch (error) {
    return { ok: false, check: { ok: false, title, ...unreached(new URL(url), error) } };
  }
}

const CERTIFICATE = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

/** Why a request got no answer, as the person setting up can act on it. */
function unreached(url: URL, error: unknown): { detail: string; fix: string } {
  const code = errorCode(error);
  const host = url.host;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      detail: `The name ${url.hostname} does not resolve from this server.`,
      fix: "Check the address for a typo, or that this server uses your company's DNS.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      detail: `Nothing accepts connections at ${host}.`,
      fix: "Check the address and its port, and that the service is running.",
    };
  }
  if (code && CERTIFICATE.has(code)) {
    return {
      detail: `This server does not trust the certificate ${host} shows.`,
      fix: "Paste your company's certificate authority under Network, then test again.",
    };
  }
  if (code === "CERT_HAS_EXPIRED") {
    return {
      detail: `The certificate ${host} shows has expired.`,
      fix: `Ask whoever runs ${url.hostname} to renew it.`,
    };
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return {
      detail: `The certificate ${host} shows is for another name.`,
      fix: "Use the address its certificate names.",
    };
  }
  if (
    code === "UND_ERR_ABORTED" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "TimeoutError"
  ) {
    return {
      detail: `${host} did not answer within ${TIMEOUT_MS / 1000} seconds.`,
      fix: "A firewall may drop the connection, or the host is reached through a proxy (Network).",
    };
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return {
      detail: `${host} closed the connection.`,
      fix: "If a proxy sits between this server and the host, set it under Network.",
    };
  }
  return {
    detail: `${host} could not be reached (${code ?? "no answer"}).`,
    fix: "Check the address, and the proxy and certificate authority under Network.",
  };
}

function errorCode(error: unknown): string | undefined {
  for (let e: unknown = error, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (typeof code === "string" && code !== "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH") return code;
    if (name === "TimeoutError") return "TimeoutError";
  }
  return undefined;
}

const field = (json: unknown, name: string) =>
  json && typeof json === "object" ? (json as Record<string, unknown>)[name] : undefined;

/** The provider's discovery document, and whether it refuses the client's id and secret. */
export async function checkSignIn(s: Settings, dispatcher: Dispatcher): Promise<Check[]> {
  const title = "Single sign-on";
  const issuer = s["signIn.issuer"]?.replace(/\/+$/, "");
  if (!issuer || !s["signIn.clientId"] || !s["signIn.clientSecret"]) {
    return [
      {
        ok: false,
        title,
        detail: "The issuer, client id and client secret are all needed.",
        fix: "Fill in the three fields.",
      },
    ];
  }
  const doc = await reach(title, `${issuer}/.well-known/openid-configuration`, dispatcher);
  if (!doc.ok) return [doc.check];
  const { status, json } = doc.answer;
  if (status !== 200 || !json) {
    return [
      {
        ok: false,
        title,
        detail: `${issuer} has no OpenID Connect discovery document (it answered ${status}).`,
        fix: "Use the issuer's address exactly, as its own documentation gives it.",
      },
    ];
  }
  const named = String(field(json, "issuer") ?? "").replace(/\/+$/, "");
  if (named !== issuer) {
    return [
      {
        ok: false,
        title,
        detail: `The provider calls itself ${named || "nothing"}, not ${issuer}.`,
        fix: named ? `Use ${named} as the issuer.` : "Check the issuer's address.",
      },
    ];
  }
  const missing = ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"].filter(
    (name) => typeof field(json, name) !== "string",
  );
  if (missing.length > 0) {
    return [
      {
        ok: false,
        title,
        detail: `The provider does not list its ${missing.join(", ")}.`,
        fix: "ocra signs people in with the authorization code flow and reads the user's profile: use a provider that offers both.",
      },
    ];
  }
  const found: Check = {
    ok: true,
    title,
    detail: `${issuer} answers as an OpenID Connect provider.`,
  };
  // A client_credentials request tells only whether the client is known:
  // a wrong id or secret is invalid_client; anything else proves nothing.
  const token = await reach(title, String(field(json, "token_endpoint")), dispatcher, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${s["signIn.clientId"]}:${s["signIn.clientSecret"]}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  if (token.ok && field(token.answer.json, "error") === "invalid_client") {
    return [
      found,
      {
        ok: false,
        title: "Client id and secret",
        detail: "The provider does not know this client id, or the secret is wrong.",
        fix: "Copy both again from the application you registered for ocra.",
      },
    ];
  }
  return [found];
}

/** GitLab's version, and the bot's user when a token is given. */
export async function checkGitlab(s: Settings, dispatcher: Dispatcher): Promise<Check[]> {
  const title = "GitLab";
  const url = s["gitlab.url"];
  if (!url)
    return [{ ok: false, title, detail: "No GitLab address.", fix: "Fill in its address." }];
  const version = await reach(title, `${url}/api/v4/version`, dispatcher);
  if (!version.ok) return [version.check];
  if (version.answer.status !== 200 && version.answer.status !== 401) {
    return [
      {
        ok: false,
        title,
        detail: `${url} does not answer as GitLab (its API answered ${version.answer.status}).`,
        fix: "Use the address you open GitLab at, without a path.",
      },
    ];
  }
  const out: Check[] = [{ ok: true, title, detail: `${url} answers as GitLab.` }];
  const token = s["gitlab.botToken"];
  if (!token) return out;
  const user = await reach("Review bot", `${url}/api/v4/user`, dispatcher, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!user.ok) return [...out, user.check];
  const name = field(user.answer.json, "username");
  out.push(
    user.answer.status === 200 && typeof name === "string"
      ? { ok: true, title: "Review bot", detail: `The token signs in as @${name}.` }
      : {
          ok: false,
          title: "Review bot",
          detail: `GitLab refused the bot's token (${user.answer.status}).`,
          fix: "Make a new personal or group access token with the api scope.",
        },
  );
  return out;
}

/** GitHub's API, and the App when its id and key are given. */
export async function checkGithub(s: Settings, dispatcher: Dispatcher): Promise<Check[]> {
  const title = "GitHub";
  const host = githubHost(s["github.url"] || "https://github.com");
  const meta = await reach(title, `${host.api}/meta`, dispatcher, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ocra-cloud" },
  });
  if (!meta.ok) return [meta.check];
  if (meta.answer.status !== 200) {
    return [
      {
        ok: false,
        title,
        detail: `${host.url} does not answer as GitHub (its API answered ${meta.answer.status}).`,
        fix: "Use the address you open GitHub at.",
      },
    ];
  }
  const out: Check[] = [{ ok: true, title, detail: `${host.url} answers as GitHub.` }];
  const id = s["github.appId"];
  const key = s["github.appPrivateKey"];
  if (!id || !key) return out;
  let jwt: string;
  try {
    jwt = await appJwt(id, key.replaceAll("\\n", "\n"));
  } catch {
    return [
      ...out,
      {
        ok: false,
        title: "GitHub App",
        detail: "The private key is not a PEM private key.",
        fix: "Paste the whole .pem file the App's page downloaded.",
      },
    ];
  }
  const app = await reach("GitHub App", `${host.api}/app`, dispatcher, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ocra-cloud",
    },
  });
  if (!app.ok) return [...out, app.check];
  const slug = field(app.answer.json, "slug");
  out.push(
    app.answer.status === 200 && typeof slug === "string"
      ? { ok: true, title: "GitHub App", detail: `The id and key are the App ${slug}'s.` }
      : {
          ok: false,
          title: "GitHub App",
          detail: `GitHub refused the App's id and key (${app.answer.status}).`,
          fix: "Check the App's number on its page, and that the key is one of its own.",
        },
  );
  return out;
}

/** A model endpoint as a test reaches it: where its models are listed, and how its key goes. */
export type Endpoint = {
  label: string;
  base: string;
  models?: string | undefined;
  auth: AuthStyle;
  key?: string | undefined;
};

export type Tiers = Partial<Record<"top" | "standard" | "light", string | undefined>>;

/** The endpoint's model list with its key, and whether it lists the model each tier names. */
export async function checkModels(
  endpoint: Endpoint,
  tiers: Tiers,
  dispatcher: Dispatcher,
): Promise<Check[]> {
  const title = endpoint.label;
  if (!endpoint.models) {
    return [
      {
        ok: true,
        note: true,
        title,
        detail: "The endpoint has no model list to test.",
        fix: "Its address and key are tested when the first review runs.",
      },
    ];
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (endpoint.key) {
    if (endpoint.auth === "x-api-key" || endpoint.auth === "both") {
      headers["x-api-key"] = endpoint.key;
      headers["anthropic-version"] = "2023-06-01";
    }
    if (endpoint.auth === "bearer" || endpoint.auth === "both") {
      headers.authorization = `Bearer ${endpoint.key}`;
    }
  }
  const list = await reach(title, `${endpoint.base}${endpoint.models}`, dispatcher, { headers });
  if (!list.ok) return [list.check];
  const { status, json } = list.answer;
  if (status === 401 || status === 403) {
    return [
      {
        ok: false,
        title,
        detail: `The endpoint refused the key (${status}).`,
        fix: endpoint.key
          ? "Check the key, and that it may list models."
          : "Add the endpoint's key.",
      },
    ];
  }
  const data = field(json, "data");
  if (status !== 200 || !Array.isArray(data)) {
    return [
      {
        ok: true,
        note: true,
        title,
        detail: `The endpoint answers, but lists no models at ${endpoint.models} (${status}).`,
        fix: "The models are tested when the first review runs: check their names against the gateway's documentation.",
      },
    ];
  }
  const ids = new Set(data.map((m) => String(field(m, "id") ?? "")));
  const out: Check[] = [
    { ok: true, title, detail: `The endpoint answers with the key and lists ${ids.size} models.` },
  ];
  for (const [tier, name] of Object.entries(tiers)) {
    if (!name) continue;
    out.push(
      ids.has(name)
        ? { ok: true, title: `The ${tier} model`, detail: `${name} is listed.` }
        : {
            ok: false,
            title: `The ${tier} model`,
            detail: `The endpoint does not list ${name}.`,
            fix: `Use a name it lists, such as ${[...ids].slice(0, 3).join(", ") || "none"}.`,
          },
    );
  }
  return out;
}

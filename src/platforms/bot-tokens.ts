import { outboundFetch } from "../calls.js";
import type { BotTokens } from "./bot.js";

// The ocra bot's credential for one review (ADR-0046, 5): on GitHub an
// installation token of the deployment's App, minted per job and limited
// to the one repository and to what a review needs; on GitLab the bot
// account's token the administrator configured. Neither is stored. Signed
// with Web Crypto, so the Worker mints it as the Node server does.

/** GitHub takes an App's JWT for at most ten minutes; a minute of clock skew is allowed for. */
const JWT_SECONDS = 9 * 60;

export type BotSettings = {
  /** The REST API of the GitHub the App is on. */
  githubApi: string;
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
  gitlabBotToken?: string | undefined;
};

const base64url = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** DER's length octets: short form below 128, else the count of length bytes first. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, content: readonly number[]) => [
  tag,
  ...derLength(content.length),
  ...content,
];

/** version 0, then rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters. */
const PKCS8_RSA_HEAD = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

/**
 * The key as PKCS#8, which is all Web Crypto imports: GitHub hands out
 * PKCS#1 keys (BEGIN RSA PRIVATE KEY), wrapped here in PKCS#8's envelope.
 */
function pkcs8Of(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return bytes;
  return Uint8Array.from(der(0x30, [...PKCS8_RSA_HEAD, ...der(0x04, [...bytes])]));
}

/** An RS256 JWT naming the App, as GitHub's App authentication asks. */
export async function appJwt(
  appId: string,
  privateKeyPem: string,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ iat, exp: iat + JWT_SECONDS, iss: appId }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Of(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

async function github(api: string, path: string, init: RequestInit & { token: string }) {
  const { token, ...rest } = init;
  const res = await outboundFetch(`${api}${path}`, {
    ...rest,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ocra-cloud",
      ...(rest.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return (await res.json()) as Record<string, unknown>;
}

/** 204 a member, 404 not; an installation token answers no 302. Null for anything else. */
async function memberStatus(api: string, path: string, token: string): Promise<boolean | null> {
  try {
    const res = await outboundFetch(`${api}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ocra-cloud",
      },
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 204 ? true : res.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/** An installation token of the App in the organisation that may read its members only. */
async function membersToken(settings: BotSettings, org: string): Promise<string | null> {
  const { githubAppId: appId, githubAppPrivateKey: key } = settings;
  if (!appId || !key) return null;
  const jwt = await appJwt(appId, key);
  const installation = await github(
    settings.githubApi,
    `/orgs/${encodeURIComponent(org)}/installation`,
    { token: jwt },
  );
  if (typeof installation?.id !== "number") return null;
  const minted = await github(
    settings.githubApi,
    `/app/installations/${installation.id}/access_tokens`,
    { token: jwt, method: "POST", body: JSON.stringify({ permissions: { members: "read" } }) },
  );
  return typeof minted?.token === "string" ? minted.token : null;
}

async function appOrgMember(settings: BotSettings, org: string, login: string) {
  const token = await membersToken(settings, org);
  if (!token) return null;
  return memberStatus(
    settings.githubApi,
    `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
    token,
  );
}

const TEAM_PAGE = 100;

async function appTeamMembers(settings: BotSettings, org: string, slug: string) {
  const token = await membersToken(settings, org);
  if (!token) return null;
  const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members`;
  const users: unknown = await github(settings.githubApi, `${path}?per_page=${TEAM_PAGE}`, {
    token,
  });
  if (!Array.isArray(users)) return null;
  return users.flatMap((u) =>
    typeof u?.id === "number" && Number.isSafeInteger(u.id) ? [String(u.id)] : [],
  );
}

export function botTokens(settings: BotSettings): BotTokens {
  return {
    // Never throws: a key Web Crypto refuses or a call that times out is
    // an answer the App cannot give, not a failed request.
    orgMember: (org, login) => appOrgMember(settings, org, login).catch(() => null),
    teamMembers: (org, slug) => appTeamMembers(settings, org, slug).catch(() => null),
    async forRepo(platform, fullName, access = "review") {
      if (platform === "gitlab") {
        return settings.gitlabBotToken ? { token: settings.gitlabBotToken } : null;
      }
      const { githubAppId: appId, githubAppPrivateKey: key } = settings;
      if (!appId || !key) return null;
      const jwt = await appJwt(appId, key);
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) return null;
      const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const [app, installation] = await Promise.all([
        github(settings.githubApi, "/app", { token: jwt }),
        github(settings.githubApi, `/repos/${path}/installation`, { token: jwt }),
      ]);
      if (typeof installation?.id !== "number") return null;
      const minted = await github(
        settings.githubApi,
        `/app/installations/${installation.id}/access_tokens`,
        {
          token: jwt,
          method: "POST",
          body: JSON.stringify({
            repositories: [repo],
            permissions: {
              contents: access === "commit" ? "write" : "read",
              pull_requests: "write",
              metadata: "read",
              checks: "write",
            },
          }),
        },
      );
      if (typeof minted?.token !== "string") return null;
      return {
        token: minted.token,
        ...(typeof app?.slug === "string" ? { login: `${app.slug}[bot]` } : {}),
      };
    },
  };
}

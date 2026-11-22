import { createPrivateKey, createSign } from "node:crypto";
import type { CodePlatformKind } from "../shared/index.js";

// The ocra bot's credential for one review (ADR-0046, 5): on GitHub an
// installation token of the deployment's App, minted per job and limited
// to the one repository and to what a review needs; on GitLab the bot
// account's token the administrator configured. Neither is stored.

const API = "https://api.github.com";
/** GitHub takes an App's JWT for at most ten minutes; a minute of clock skew is allowed for. */
const JWT_SECONDS = 9 * 60;

export type BotCredential = {
  token: string;
  /** The login the bot posts as, which ocra trusts to have written its own summary. */
  login?: string;
};

/** What the bot's token may do: comment on pull requests, or also push to their branches. */
export type BotAccess = "review" | "commit";

export type BotTokens = {
  /** null when this deployment has no bot for the platform, or it was refused. */
  forRepo(
    platform: CodePlatformKind,
    fullName: string,
    access?: BotAccess,
  ): Promise<BotCredential | null>;
};

export type BotSettings = {
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
  gitlabBotToken?: string | undefined;
};

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** An RS256 JWT naming the App, as GitHub's App authentication asks. */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ iat, exp: iat + JWT_SECONDS, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  // GitHub hands out PKCS#1 keys; createPrivateKey reads both PKCS#1 and PKCS#8.
  return `${head}.${body}.${base64url(signer.sign(createPrivateKey(privateKeyPem)))}`;
}

async function github(path: string, init: RequestInit & { token: string }) {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
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

export function botTokens(settings: BotSettings): BotTokens {
  return {
    async forRepo(platform, fullName, access = "review") {
      if (platform === "gitlab") {
        return settings.gitlabBotToken ? { token: settings.gitlabBotToken } : null;
      }
      const { githubAppId: appId, githubAppPrivateKey: key } = settings;
      if (!appId || !key) return null;
      const jwt = appJwt(appId, key);
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) return null;
      const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const [app, installation] = await Promise.all([
        github("/app", { token: jwt }),
        github(`/repos/${path}/installation`, { token: jwt }),
      ]);
      if (typeof installation?.id !== "number") return null;
      const minted = await github(`/app/installations/${installation.id}/access_tokens`, {
        token: jwt,
        method: "POST",
        body: JSON.stringify({
          repositories: [repo],
          permissions: {
            contents: access === "commit" ? "write" : "read",
            pull_requests: "write",
            metadata: "read",
          },
        }),
      });
      if (typeof minted?.token !== "string") return null;
      return {
        token: minted.token,
        ...(typeof app?.slug === "string" ? { login: `${app.slug}[bot]` } : {}),
      };
    },
  };
}

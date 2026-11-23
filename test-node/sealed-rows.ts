import { encryptSecret, keyBinding } from "../src/crypto.js";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import type { Db } from "../src/db/client.js";
import { type Scoped, scoped } from "../src/db/scoped.js";
import { keyFor } from "../src/keyring.js";
import { openHook, sealHook } from "../src/notify/notify.js";
import { accessToken, saveToken } from "../src/platforms/links.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { openRepoToken, sealRepoToken } from "../src/platforms/repo-token.js";

// A row of every sealed kind, for the master key rotation's tests: sealed
// under the old key, but for one channel the service saved during the
// rotation, already under the new key.

const keyOf = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
export const OLD = keyOf(1);
export const NEW = keyOf(2);
export const SECRETS = {
  provider: "sk-provider-secret-value",
  platform: "gho_platform-secret-value",
  repo: "glpat-repo-secret-value",
  slackDm: JSON.stringify({ user: "U0SECRET01", channel: "D0SECRET01" }),
  webhook: "https://hooks.example.com/secret-path",
};
const github = { kind: "github", host: "github.com" } as CodePlatform;

export type Sealed = { data: Scoped; repoId: string; dmId: string; laterId: string };

export async function sealEveryKind(db: Db): Promise<Sealed> {
  const account = await upsertAccount(db, githubIdentity(1), "octo");
  const data = scoped(db, account.id);
  await data.insert("providerKeys", {
    provider: "openrouter",
    ...(await encryptSecret(OLD, SECRETS.provider, keyBinding(account.id, "openrouter"))),
    last4: "alue",
  });
  await saveToken(data, { MASTER_KEY: OLD }, github, { access_token: SECRETS.platform });
  const repoId = await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.com",
    platformRepoId: "11",
    fullName: "acme/api",
  });
  const sealed = await sealRepoToken(OLD, { accountId: account.id, id: repoId }, SECRETS.repo);
  await data.update("reviewRepos", repoId, {
    accessTokenWrappedKey: sealed.wrappedKey,
    accessTokenCiphertext: sealed.ciphertext,
  });
  // A repository without a token of its own is left as it is.
  await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.com",
    platformRepoId: "12",
    fullName: "acme/web",
  });
  const channel = async (kind: "slack_dm" | "webhook", key: string, address: string) => {
    const id = await data.insert("notifyChannels", {
      kind,
      name: kind,
      when: "every",
      wrappedKey: "w",
      ciphertext: "c",
      last4: "abcd",
    });
    await data.update("notifyChannels", id, await sealHook(key, account.id, id, address));
    return id;
  };
  const dmId = await channel("slack_dm", OLD, SECRETS.slackDm);
  const laterId = await channel("webhook", NEW, SECRETS.webhook);
  return { data, repoId, dmId, laterId };
}

/** What each sealed row opens to with the new key alone. */
export async function openedWithNewKeyOnly({ data, repoId, dmId, laterId }: Sealed) {
  const only = { current: NEW };
  const repo = await data.get("reviewRepos", repoId);
  const dm = await data.get("notifyChannels", dmId);
  const later = await data.get("notifyChannels", laterId);
  return {
    provider: await keyFor(data, only, "openrouter").catch(() => null),
    platform: await accessToken(data, { MASTER_KEY: NEW }, github).catch(() => null),
    repo: repo ? await openRepoToken(only, repo).catch(() => null) : null,
    slackDm: dm ? await openHook(only, dm).catch(() => null) : null,
    webhook: later ? await openHook(only, later).catch(() => null) : null,
  };
}

/** A provider key sealed under the old key, and one under neither. */
export async function addUnopenable(data: Scoped) {
  const sealed = (provider: string, key: string) =>
    encryptSecret(key, `sk-${provider}`, keyBinding(data.accountId, provider));
  await data.insert("providerKeys", {
    provider: "deepseek",
    ...(await sealed("deepseek", OLD)),
    last4: "seek",
  });
  await data.insert("providerKeys", {
    provider: "anthropic",
    ...(await sealed("anthropic", keyOf(3))),
    last4: "opic",
  });
}

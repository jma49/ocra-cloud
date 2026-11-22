import { decryptWithAny, encryptSecret, type MasterKeys } from "../crypto.js";
import type { Scoped } from "../db/scoped.js";
import { masterKeys } from "../keyring.js";
import type { AppBindings } from "../types.js";
import type { CodePlatform, TokenAnswer } from "./platform.js";

// The account's token on each code platform: stored when the user connects
// it (for GitHub, at sign-in), refreshed when it expires, dropped when it no
// longer decrypts or the platform refuses the refresh. Never logged, never
// answered, never exported.

type Tokens = { access: string; refresh?: string };
type Keys = Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">;

const binding = (accountId: string, p: CodePlatform) =>
  `ocra-platform-token:v1|${accountId}|${p.kind}|${p.host}`;
const after = (now: number, seconds: number | undefined) =>
  typeof seconds === "number" ? new Date(now + seconds * 1000) : null;
/** A minute's margin, so a call does not start with a token about to lapse. */
const MARGIN_MS = 60_000;

/**
 * Stores the platform's answer, replacing the account's previous token
 * there, with the id of the user it is of when the caller read it (a
 * refresh keeps the one stored).
 */
export async function saveToken(
  data: Scoped,
  env: Pick<Keys, "MASTER_KEY">,
  platform: CodePlatform,
  answer: TokenAnswer,
  now = Date.now(),
  userId?: string,
): Promise<void> {
  if (!answer.access_token) return;
  const tokens: Tokens = {
    access: answer.access_token,
    ...(answer.refresh_token ? { refresh: answer.refresh_token } : {}),
  };
  const sealed = await encryptSecret(
    env.MASTER_KEY,
    JSON.stringify(tokens),
    binding(data.accountId, platform),
  );
  const row = {
    platform: platform.kind,
    host: platform.host,
    ...sealed,
    accessExpiresAt: after(now, answer.expires_in),
    refreshExpiresAt: after(now, answer.refresh_token_expires_in),
    ...(userId !== undefined ? { userId } : {}),
  };
  await data.batch((w) => [w.upsert("platformLinks", row, ["accountId", "platform", "host"])]);
}

type Link = { wrappedKey: string; ciphertext: string };

async function open(keys: MasterKeys, data: Scoped, p: CodePlatform, link: Link) {
  try {
    return JSON.parse(await decryptWithAny(keys, link, binding(data.accountId, p))) as Tokens;
  } catch {
    return null;
  }
}

/**
 * The account's usable access token on the platform, refreshed first when
 * it expired; null when there is none, or it can no longer be used (the
 * link is dropped then).
 */
export async function accessToken(
  data: Scoped,
  env: Keys,
  platform: CodePlatform,
  now = Date.now(),
): Promise<string | null> {
  const where = { platform: platform.kind, host: platform.host };
  const keys = masterKeys(env);
  const drop = async () => {
    await data.removeWhere("platformLinks", where);
    return null;
  };
  const row = await data.findOne("platformLinks", where);
  if (!row) return null;
  const tokens = await open(keys, data, platform, row);
  if (!tokens) return drop();
  if (!row.accessExpiresAt || row.accessExpiresAt.getTime() > now + MARGIN_MS) {
    return tokens.access;
  }
  if (!tokens.refresh) return drop();
  const answer = await platform.refresh(tokens.refresh);
  if (!answer?.access_token) {
    // A refresh token works once: a request running beside this one may
    // have used it and stored the new pair. Only when nothing changed is
    // the link dead.
    const latest = await data.findOne("platformLinks", where);
    if (latest && latest.ciphertext !== row.ciphertext) {
      const fresh = await open(keys, data, platform, latest);
      if (fresh) return fresh.access;
    }
    return drop();
  }
  await saveToken(data, env, platform, answer, now);
  return answer.access_token;
}

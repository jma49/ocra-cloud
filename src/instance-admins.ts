import type { Identity } from "./db/accounts.js";

// INSTANCE_ADMINS: who may read the deployment's state (GET /api/admin/instance),
// as a comma list of `github:<numeric user id>` and `oidc:<subject>`. These
// are the identities an account signs in with, which never change; a GitHub
// login can be renamed and taken by someone else, and an OpenID Connect
// username is whatever the provider sends, so neither is accepted. Unset,
// nobody may.

const MAX_ENTRIES = 50;
const GITHUB_ID = /^[1-9]\d{0,19}$/;

/**
 * The identities INSTANCE_ADMINS lists, or none when it is unset or blank;
 * throws naming the first entry it cannot read, so a server with a list it
 * would misread does not start.
 */
export function instanceAdminsOf(raw: string | undefined): Identity[] {
  if (!raw?.trim()) return [];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length > MAX_ENTRIES) {
    throw new Error(`INSTANCE_ADMINS holds more than ${MAX_ENTRIES} entries`);
  }
  return items.map((item): Identity => {
    const colon = item.indexOf(":");
    const kind = colon > 0 ? item.slice(0, colon).trim().toLowerCase() : "";
    const value = item.slice(colon + 1).trim();
    if (kind === "github" && GITHUB_ID.test(value)) return { provider: "github", subject: value };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    if (kind === "oidc" && value && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value)) {
      return { provider: "oidc", subject: value };
    }
    throw new Error(`INSTANCE_ADMINS: "${item}" is not github:<numeric user id> or oidc:<subject>`);
  });
}

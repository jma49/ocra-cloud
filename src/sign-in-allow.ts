import { sha256Hex } from "./crypto.js";

// SIGN_IN_ALLOW: who may sign in to a self-hosted server, as a comma list of
// `org:<github org>`, `user:<github login>`, `domain:<email domain>` and
// `group:<oidc group>`. Unset, anyone the sign-in providers vouch for may.
// Every entry is normalised before it is compared: logins and domains
// lowercased, a domain in its ASCII (punycode) form.

type AllowKind = "org" | "user" | "domain" | "group";
export type AllowList = {
  orgs: string[];
  users: string[];
  domains: string[];
  groups: string[];
  /** A hash of the normalised list: an account checked against another list is checked again. */
  key: string;
};

/** The most entries one list holds, which bounds the membership calls of a check. */
const MAX_ENTRIES = 50;

// GitHub's logins and organisations, with `_` for Enterprise Managed Users.
const GITHUB_NAME = /^[a-z0-9_](?:[a-z0-9_-]{0,98}[a-z0-9_])?$/;
const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

/** A domain in its lowercased ASCII form, or undefined when it is not a plain host name. */
function domainOf(raw: string): string | undefined {
  const text = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!text || /[/\\@:?#%\s[\]]/.test(text)) return undefined;
  let host: string;
  try {
    host = new URL(`https://${text}/`).hostname;
  } catch {
    return undefined;
  }
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    return undefined;
  }
  // An address such as 10.0.0.1 is no email domain.
  if (/^\d+$/.test(labels.at(-1) ?? "")) return undefined;
  return host;
}

/** The domain of an email address, normalised as domainOf does. */
export function emailDomainOf(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const at = email.lastIndexOf("@");
  return at > 0 ? domainOf(email.slice(at + 1)) : undefined;
}

function entryOf(raw: string, kind: string, value: string): string {
  const fail = () => {
    throw new Error(`SIGN_IN_ALLOW: "${raw}" is not org:, user:, domain: or group: with a value`);
  };
  switch (kind) {
    case "org":
    case "user": {
      const name = value.trim().toLowerCase();
      return GITHUB_NAME.test(name) ? name : fail();
    }
    case "domain":
      return domainOf(value) ?? fail();
    case "group": {
      const group = value.trim();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
      return group && group.length <= 256 && !/[\u0000-\u001f\u007f]/.test(group) ? group : fail();
    }
    default:
      return fail();
  }
}

type Entries = Omit<AllowList, "key">;

/**
 * The entries SIGN_IN_ALLOW lists, normalised, or undefined when it is unset
 * or blank; throws naming the first entry it cannot read, so a server with a
 * list it would misread does not start.
 */
export function allowEntriesOf(raw: string | undefined): Entries | undefined {
  if (!raw?.trim()) return undefined;
  const found: Record<AllowKind, Set<string>> = {
    org: new Set(),
    user: new Set(),
    domain: new Set(),
    group: new Set(),
  };
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length > MAX_ENTRIES) {
    throw new Error(`SIGN_IN_ALLOW holds more than ${MAX_ENTRIES} entries`);
  }
  for (const item of items) {
    const colon = item.indexOf(":");
    const kind = colon > 0 ? item.slice(0, colon).trim().toLowerCase() : "";
    const value = entryOf(item, kind, item.slice(colon + 1));
    found[kind as AllowKind].add(value);
  }
  const sorted = (k: AllowKind) => [...found[k]].sort();
  return {
    orgs: sorted("org"),
    users: sorted("user"),
    domains: sorted("domain"),
    groups: sorted("group"),
  };
}

/** The list SIGN_IN_ALLOW sets, with its key; undefined when it is unset. */
export async function allowListOf(raw: string | undefined): Promise<AllowList | undefined> {
  const entries = allowEntriesOf(raw);
  return entries && { ...entries, key: await sha256Hex(JSON.stringify(entries)) };
}

/** Whether any of `values` is in `allowed`; GitHub names and domains are compared lowercased. */
export const anyIn = (allowed: readonly string[], values: readonly string[]) =>
  values.some((v) => allowed.includes(v));

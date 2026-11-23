import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { formatModelId, SETUP_SETTINGS, type SetupSettingName } from "../../shared/index.js";

// What the setup page edits, by name, and the environment variables each
// stands for. A server's settings are its environment variables (../env.ts);
// the page saves them in the database instead, and a variable set in the
// environment wins over a saved value, which the page then shows as locked.

type Field = {
  /** Sealed when stored, and never sent back to the page. */
  secret?: true;
  /** The variables that, set in the environment, lock it. */
  env: readonly string[];
  value: z.ZodType<string>;
};

const httpUrl = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "an address starting with https://")
  .transform((v) => v.replace(/\/+$/, ""));
const word = z.string().trim().min(1).max(200);
const secret = z.string().trim().min(1).max(8192);
const model = z
  .string()
  .trim()
  .regex(/^[\w.:@/-]{1,200}$/, "a model name, as the gateway lists it");

const pem = z
  .string()
  .trim()
  .max(256 * 1024)
  .refine((text) => certificates(text).length > 0, "one or more PEM certificates")
  .refine(
    (text) =>
      certificates(text).every((c) => {
        try {
          new X509Certificate(c);
          return true;
        } catch {
          return false;
        }
      }),
    "a certificate that does not parse",
  );

/** The PEM blocks of a bundle. */
export function certificates(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

export const FIELDS = {
  "network.caCertificates": { env: ["NODE_EXTRA_CA_CERTS"], value: pem },
  // A proxy's address may carry its password.
  "network.httpsProxy": { secret: true, env: ["HTTPS_PROXY", "https_proxy"], value: httpUrl },
  "network.noProxy": { env: ["NO_PROXY", "no_proxy"], value: word },

  "signIn.issuer": { env: ["OIDC_ISSUER"], value: httpUrl },
  "signIn.clientId": { env: ["OIDC_CLIENT_ID"], value: word },
  "signIn.clientSecret": { secret: true, env: ["OIDC_CLIENT_SECRET"], value: secret },
  "signIn.name": { env: ["OIDC_NAME"], value: z.string().trim().min(1).max(40) },
  "signIn.allow": { env: ["SIGN_IN_ALLOW"], value: word },

  "gitlab.url": { env: ["GITLAB_URL"], value: httpUrl },
  "gitlab.clientId": { env: ["GITLAB_CLIENT_ID"], value: word },
  "gitlab.clientSecret": { secret: true, env: ["GITLAB_CLIENT_SECRET"], value: secret },
  "gitlab.botToken": { secret: true, env: ["GITLAB_BOT_TOKEN"], value: secret },

  "github.url": { env: ["GITHUB_URL"], value: httpUrl },
  "github.clientId": { env: ["GITHUB_CLIENT_ID"], value: word },
  "github.clientSecret": { secret: true, env: ["GITHUB_CLIENT_SECRET"], value: secret },
  "github.appSlug": { env: ["GITHUB_APP_SLUG"], value: word },
  "github.appId": { env: ["GITHUB_APP_ID"], value: z.string().trim().regex(/^\d+$/, "a number") },
  "github.appPrivateKey": { secret: true, env: ["GITHUB_APP_PRIVATE_KEY"], value: secret },
  "github.webhookSecret": { secret: true, env: ["GITHUB_WEBHOOK_SECRET"], value: secret },

  "models.base": { env: ["MODEL_ENDPOINTS"], value: httpUrl },
  "models.wire": { env: ["MODEL_ENDPOINTS"], value: z.enum(["openai", "anthropic"]) },
  "models.key": { secret: true, env: ["MODEL_ENDPOINTS"], value: secret },
  "models.top": { env: ["DEFAULT_MODELS"], value: model },
  "models.standard": { env: ["DEFAULT_MODELS"], value: model },
  "models.light": { env: ["DEFAULT_MODELS"], value: model },
  "models.builtin": { env: ["BUILTIN_PROVIDERS"], value: z.enum(["on", "off"]) },
} as const satisfies Record<SetupSettingName, Field>;

export type SettingName = SetupSettingName;
export type Settings = Partial<Record<SettingName, string>>;

export const SETTING_NAMES: readonly SettingName[] = SETUP_SETTINGS;

export const isSecret = (name: SettingName): boolean => "secret" in FIELDS[name];

/** Whether the environment sets a variable the setting stands for. */
export function lockedBy(name: SettingName, env: Record<string, string | undefined>) {
  return FIELDS[name].env.find((v) => !!env[v]);
}

/** The id the page's model gateway takes among the server's providers: models are `ocra-company/<name>`. */
const GATEWAY_ID = "company";

/** The environment variables the saved settings stand for. */
export function varsOf(s: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) out[name] = value;
  };
  set("HTTPS_PROXY", s["network.httpsProxy"]);
  set("HTTP_PROXY", s["network.httpsProxy"]);
  set("NO_PROXY", s["network.noProxy"]);

  set("OIDC_ISSUER", s["signIn.issuer"]);
  set("OIDC_CLIENT_ID", s["signIn.clientId"]);
  set("OIDC_CLIENT_SECRET", s["signIn.clientSecret"]);
  set("OIDC_NAME", s["signIn.name"]);
  set("SIGN_IN_ALLOW", s["signIn.allow"]);

  set("GITLAB_URL", s["gitlab.url"]);
  set("GITLAB_CLIENT_ID", s["gitlab.clientId"]);
  set("GITLAB_CLIENT_SECRET", s["gitlab.clientSecret"]);
  set("GITLAB_BOT_TOKEN", s["gitlab.botToken"]);

  if (s["github.url"] && new URL(s["github.url"]).host !== "github.com") {
    set("GITHUB_URL", s["github.url"]);
  }
  set("GITHUB_CLIENT_ID", s["github.clientId"]);
  set("GITHUB_CLIENT_SECRET", s["github.clientSecret"]);
  set("GITHUB_APP_SLUG", s["github.appSlug"]);
  set("GITHUB_APP_ID", s["github.appId"]);
  set("GITHUB_APP_PRIVATE_KEY", s["github.appPrivateKey"]);
  set("GITHUB_WEBHOOK_SECRET", s["github.webhookSecret"]);

  const gateway = gatewayOf(s);
  if (gateway) {
    set("MODEL_ENDPOINTS", JSON.stringify([gateway]));
    const tiers = Object.fromEntries(
      (["top", "standard", "light"] as const).flatMap((tier) => {
        const m = s[`models.${tier}`];
        return m ? [[tier, [formatModelId(GATEWAY_ID, m)]]] : [];
      }),
    );
    if (Object.keys(tiers).length > 0) set("DEFAULT_MODELS", JSON.stringify(tiers));
  }
  set("BUILTIN_PROVIDERS", s["models.builtin"] ?? (gateway ? "off" : undefined));
  return out;
}

/** The model gateway as a MODEL_ENDPOINTS entry: OpenAI's chat completions or Anthropic's messages. */
export function gatewayOf(s: Settings) {
  const base = s["models.base"];
  if (!base) return undefined;
  const anthropic = s["models.wire"] === "anthropic";
  return {
    id: GATEWAY_ID,
    label: "Company models",
    // The paths below carry /v1: a base copied with it would double it.
    base: base.replace(/\/v1$/, ""),
    paths: [anthropic ? "/v1/messages" : "/v1/chat/completions"],
    auth: anthropic ? ("x-api-key" as const) : ("bearer" as const),
    models: "/v1/models",
    ...(s["models.key"] ? { key: s["models.key"] } : {}),
  };
}

/** Each value checked against its field; the issues name the field. */
export function checkSettings(input: Record<string, string | null>) {
  const values: Record<string, string | null> = {};
  const issues: { path: string[]; message: string }[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (!(name in FIELDS)) {
      issues.push({ path: [name], message: "not a setting" });
      continue;
    }
    if (raw === null || raw.trim() === "") {
      values[name] = null;
      continue;
    }
    const parsed = FIELDS[name as SettingName].value.safeParse(raw);
    if (parsed.success) values[name] = parsed.data;
    else issues.push({ path: [name], message: parsed.error.issues[0]?.message ?? "not valid" });
  }
  return { values: values as Partial<Record<SettingName, string | null>>, issues };
}

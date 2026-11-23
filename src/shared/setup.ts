// A self-hosted server's settings page (/api/setup, src/node/setup/): the
// settings it holds, by name, and what its answers carry.

export const SETUP_SETTINGS = [
  "network.caCertificates",
  "network.httpsProxy",
  "network.noProxy",
  "signIn.issuer",
  "signIn.clientId",
  "signIn.clientSecret",
  "signIn.name",
  "signIn.allow",
  "gitlab.url",
  "gitlab.clientId",
  "gitlab.clientSecret",
  "gitlab.botToken",
  "github.url",
  "github.clientId",
  "github.clientSecret",
  "github.appSlug",
  "github.appId",
  "github.appPrivateKey",
  "github.webhookSecret",
  "models.base",
  "models.wire",
  "models.key",
  "models.top",
  "models.standard",
  "models.light",
  "models.builtin",
] as const;

export type SetupSettingName = (typeof SETUP_SETTINGS)[number];

/** The steps whose connection the page tests. */
export const SETUP_CHECKS = ["signIn", "gitlab", "github", "models"] as const;
export type SetupCheckStep = (typeof SETUP_CHECKS)[number];

/** GET /api/setup, to anyone. */
export type SetupState = { needed: boolean; startedAt: number };

/** A setting as the page shows it: a secret only as set, never its value. */
type SetupField = { set: boolean; value?: string; lockedBy?: string };

/** GET and PUT /api/setup/settings. */
export type SetupSettingsView = {
  fields: Record<SetupSettingName, SetupField>;
  /** What the providers' applications for ocra are given. */
  addresses: { signIn: string; gitlab: string; github: string; githubWebhook: string };
};

/**
 * One test of a connection or of a part of the server, in plain words. A
 * note is a choice the server runs with (a part left off), not a test.
 */
export type SetupCheck = { ok: boolean; note?: true; title: string; detail: string; fix?: string };

/** GET /api/setup/health. */
export type SetupHealth = { sections: { title: string; checks: SetupCheck[] }[] };

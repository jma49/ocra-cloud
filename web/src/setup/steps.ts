import Activity from "lucide-react/icons/activity";
import Cpu from "lucide-react/icons/cpu";
import GitBranch from "lucide-react/icons/git-branch";
import KeyRound from "lucide-react/icons/key-round";
import Network from "lucide-react/icons/network";
import type {
  SetupCheckStep,
  SetupSettingName,
  SetupSettingsView,
} from "../../../src/shared/index.js";

// The setup page's steps, in the order an operator takes them: the network
// first, since every test after it goes through it.

export type FieldDef = {
  name: SetupSettingName;
  label: string;
  hint?: string;
  kind?: "secret" | "textarea" | "mono";
  placeholder?: string;
};

export type FormDef = {
  fields: FieldDef[];
  /** The connection test of these fields. */
  check?: SetupCheckStep;
  /** An address the provider's application for ocra is given. */
  address?: { label: string; of: keyof SetupSettingsView["addresses"] }[];
};

export type StepId = "network" | "signIn" | "host" | "models" | "health";

export const STEPS: { id: StepId; label: string; icon: typeof Network }[] = [
  { id: "network", label: "Network", icon: Network },
  { id: "signIn", label: "Sign-in", icon: KeyRound },
  { id: "host", label: "Code host", icon: GitBranch },
  { id: "models", label: "Models", icon: Cpu },
  { id: "health", label: "Health", icon: Activity },
];

export const NETWORK: FormDef = {
  fields: [
    {
      name: "network.caCertificates",
      label: "Certificate authority",
      kind: "textarea",
      hint: "Your company's root certificate, as PEM, when GitLab, the sign-in provider or the model gateway use one. Paste several one after another.",
      placeholder: "-----BEGIN CERTIFICATE-----",
    },
    {
      name: "network.httpsProxy",
      label: "Proxy",
      kind: "secret",
      hint: "The proxy this server goes out through, if any.",
      placeholder: "http://proxy.example.com:3128",
    },
    {
      name: "network.noProxy",
      label: "Reached without the proxy",
      kind: "mono",
      hint: "Hosts inside the network, separated by commas.",
      placeholder: "gitlab.example.com,.corp.example.com",
    },
  ],
};

export const SIGN_IN: FormDef = {
  check: "signIn",
  address: [{ label: "Redirect URI", of: "signIn" }],
  fields: [
    {
      name: "signIn.issuer",
      label: "Issuer",
      kind: "mono",
      hint: "Your single sign-on's OpenID Connect issuer: Keycloak, Okta, Azure AD, or GitLab itself.",
      placeholder: "https://sso.example.com/realms/company",
    },
    { name: "signIn.clientId", label: "Client id", kind: "mono" },
    { name: "signIn.clientSecret", label: "Client secret", kind: "secret" },
    {
      name: "signIn.name",
      label: "Button name",
      hint: "What the sign-in button says after “Continue with”.",
      placeholder: "SSO",
    },
    {
      name: "signIn.allow",
      label: "Who may sign in",
      kind: "mono",
      hint: "Leave empty for anyone the provider vouches for, or list groups, email domains and organizations.",
      placeholder: "group:company/eng,domain:example.com",
    },
  ],
};

export const GITLAB: FormDef = {
  check: "gitlab",
  address: [{ label: "Redirect URI", of: "gitlab" }],
  fields: [
    {
      name: "gitlab.url",
      label: "GitLab address",
      kind: "mono",
      placeholder: "https://gitlab.example.com",
    },
    {
      name: "gitlab.clientId",
      label: "Application id",
      kind: "mono",
      hint: "An application in GitLab's Admin area, scope api. When it is also the sign-in's, add both redirect URIs to it.",
    },
    { name: "gitlab.clientSecret", label: "Application secret", kind: "secret" },
    {
      name: "gitlab.botToken",
      label: "Review bot's token",
      kind: "secret",
      hint: "An access token of the account ocra posts reviews as: scope api, Developer role. Without it, nobody's merge requests are reviewed here.",
    },
  ],
};

export const GITHUB: FormDef = {
  check: "github",
  address: [
    { label: "Callback URL", of: "github" },
    { label: "Webhook URL", of: "githubWebhook" },
  ],
  fields: [
    {
      name: "github.url",
      label: "GitHub address",
      kind: "mono",
      hint: "Leave empty for github.com; a GitHub Enterprise Server's own address otherwise.",
      placeholder: "https://github.com",
    },
    { name: "github.clientId", label: "App's client id", kind: "mono" },
    { name: "github.clientSecret", label: "App's client secret", kind: "secret" },
    { name: "github.appSlug", label: "App's name in its URL", kind: "mono" },
    { name: "github.appId", label: "App id", kind: "mono" },
    {
      name: "github.appPrivateKey",
      label: "App's private key",
      kind: "secret",
      hint: "The .pem file from the App's page. With the App id, ocra reviews pull requests as the App.",
    },
    { name: "github.webhookSecret", label: "Webhook secret", kind: "secret" },
  ],
};

export const MODELS: FormDef = {
  check: "models",
  fields: [
    {
      name: "models.base",
      label: "Gateway address",
      kind: "mono",
      hint: "Where your company's models answer, with or without its /v1.",
      placeholder: "https://llm.example.com/v1",
    },
    { name: "models.key", label: "Gateway key", kind: "secret" },
    {
      name: "models.top",
      label: "Top model",
      kind: "mono",
      hint: "For the hardest reviews. The model names as the gateway lists them; a tier left empty takes the nearest one set.",
      placeholder: "qwen3-coder-480b",
    },
    { name: "models.standard", label: "Standard model", kind: "mono" },
    { name: "models.light", label: "Light model", kind: "mono" },
  ],
};

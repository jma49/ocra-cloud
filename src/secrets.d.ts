// Worker secrets (wrangler secret put), which `wrangler types` cannot see.
// Both Env and Cloudflare.Env extend this generated interface.
interface __BaseEnv_Env {
  GITHUB_CLIENT_SECRET: string;
  /** base64 of 32 random bytes: wraps every data key. */
  MASTER_KEY: string;
  /** Set only during a master-key rotation: the key being replaced (docs/rotation.md). */
  MASTER_KEY_PREVIOUS?: string;
  /** Signs the OAuth state cookie. */
  SESSION_SECRET: string;
  /** A GitHub Enterprise Server's address; github.com when unset (docs/self-hosting.md). */
  GITHUB_URL?: string;
  /** A GitLab OAuth application, set to let accounts connect GitLab (docs/self-hosting.md). */
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  /** The GitLab instance; https://gitlab.com when unset. */
  GITLAB_URL?: string;
  /** An OpenID Connect provider to sign in through, as a self-hosted server's SSO (docs/self-hosting.md). */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  /** The provider's name on the sign-in button. */
  OIDC_NAME?: string;
  /** Who may sign in, as org:, user:, domain: and group: entries (docs/self-hosting.md); anyone when unset. */
  SIGN_IN_ALLOW?: string;
  /** A self-hosted server's own model endpoints, as JSON (docs/self-hosting.md); may hold their keys. */
  MODEL_ENDPOINTS?: string;
  /** off: forward to MODEL_ENDPOINTS only, never to the built-in public providers. */
  BUILTIN_PROVIDERS?: string;
  /** The default models, as JSON, that an account starts with until it saves its own. */
  DEFAULT_MODELS?: string;
  /** The GitHub App's number and private key (PEM), which mint the ocra bot's token for each hosted job. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The GitHub App's webhook secret; its webhooks are refused without it. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** A GitLab bot account's token (scope api), which posts the reviews of GitLab projects without a token of their own. */
  GITLAB_BOT_TOKEN?: string;
  /** What remote runners prove themselves with (docs/runner.md); with the GitHub App's three above, GITLAB_BOT_TOKEN or the GitLab application (for projects given their own access token), hosted reviews are on. */
  RUNNER_TOKEN?: string;
  /** off: the remote runners build no code graphs and none is kept (src/graph/remote.ts); kept when unset. */
  CODE_GRAPH?: string;
  /** The address people open: the daily digest's links, sent from the cron with no request to read it from. */
  PUBLIC_URL?: string;
}

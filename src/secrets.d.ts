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
  /** A self-hosted server's own model endpoints, as JSON (docs/self-hosting.md); may hold their keys. */
  MODEL_ENDPOINTS?: string;
  /** off: forward to MODEL_ENDPOINTS only, never to the built-in public providers. */
  BUILTIN_PROVIDERS?: string;
  /** The default models, as JSON, that an account starts with until it saves its own. */
  DEFAULT_MODELS?: string;
}

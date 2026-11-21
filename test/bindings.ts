// The Worker's test settings, beside wrangler.jsonc's vars: the workerd
// project's miniflare bindings, and the Postgres project's env.
export const TEST_BINDINGS = {
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  // A self-hosted GitLab, with a port the CLI's identity drops.
  GITLAB_CLIENT_ID: "test-gitlab-app",
  GITLAB_CLIENT_SECRET: "test-gitlab-secret",
  GITLAB_URL: "https://gitlab.example.com:8443",
  // A company's SSO, as a self-hosted server signs people in.
  OIDC_ISSUER: "https://sso.example.com/realms/eng",
  OIDC_CLIENT_ID: "ocra-cloud",
  OIDC_CLIENT_SECRET: "test-oidc-secret",
  OIDC_NAME: "Example SSO",
  GATEWAY_DAILY_CALLS: "3",
  REVIEW_DAILY_UPLOADS: "500",
  REVIEW_MAX_FINDINGS: "20000",
  DEVICE_DAILY_CODES: "500",
  // Above what a test file asks for from one address.
  DEVICE_DAILY_CODES_PER_NETWORK: "100",
};

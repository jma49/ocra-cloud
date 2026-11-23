import { memoryRateLimit } from "../src/node/limits.js";
import { TEST_BINDINGS } from "../test/bindings.js";

export const rateLimits = () => ({
  DEVICE_CODES: memoryRateLimit(10, 60),
  DEVICE_LOOKUPS: memoryRateLimit(20, 60),
  ACCOUNT_CALLS: memoryRateLimit(120, 60),
});

// cloudflare:workers in the Postgres project: the Worker's env, from
// wrangler.jsonc's GitHub app and the test bindings (which set every limit),
// with the rate limits in memory.
export const env = {
  GITHUB_CLIENT_ID: "Iv23liQIb7RBK0JvrxbN",
  GITHUB_APP_SLUG: "ocra-cloud",
  ...TEST_BINDINGS,
  DB: {},
  TEST_MIGRATIONS: [],
  ...rateLimits(),
};

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          GITHUB_CLIENT_SECRET: "test-client-secret",
          MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
          SESSION_SECRET: "test-session-secret",
          GATEWAY_DAILY_CALLS: "3",
          REVIEW_DAILY_UPLOADS: "500",
          REVIEW_MAX_FINDINGS: "20000",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});

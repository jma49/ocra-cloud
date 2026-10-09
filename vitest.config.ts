import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects in one run: the Worker's tests in workerd, with a local D1;
// the web app's in a simulated browser.
export default defineConfig({
  test: {
    projects: [
      {
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
                DEVICE_DAILY_CODES: "500",
                // Above what a test file asks for from one address.
                DEVICE_DAILY_CODES_PER_NETWORK: "100",
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["web/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});

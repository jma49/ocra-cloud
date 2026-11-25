import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "./test/bindings.js";

// Tests of D1 itself (its query plans, migrations written for it, its
// binding replaced to count or fail statements) and of workerd's own
// request streams and timers, and one that loads the Worker's module again
// (with a bot), which here would open a second database.
const POSTGRES_EXCLUDE = [
  "test/query-plans.test.ts",
  "test/preferences-backfill.test.ts",
  "test/pull-view-names.test.ts",
  "test/notify-deliveries-migration.test.ts",
  "test/usage-backfill.test.ts",
  "test/finding-threads-backfill.test.ts",
  "test/upload-atomic.test.ts",
  "test/logs.test.ts",
  "test/health.test.ts",
  "test/body-limits.test.ts",
  "test/timeouts.test.ts",
  "test/automation-retry-cron.test.ts",
  // A Durable Object.
  "test/pulls-stream.test.ts",
];

// Four projects in one run: the Worker's tests in workerd, with a local D1;
// the same tests on Node with Postgres (PGlite), but those that read D1
// itself; the self-hosted server's on Node, with a SQLite file; the web
// app's in a simulated browser.

// A CI job keeps every core of its runner busy, where a test that starts
// PGlite or imports the whole app can pass five seconds,
// and a hook that starts PGlite from the run's cluster and migrates it
// took up to 8.7 s with twice as many busy loops as cores.
const SHARED_RUNNER_TIMEOUT = 15_000;

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
                ...TEST_BINDINGS,
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
        resolve: {
          alias: {
            "cloudflare:workers": resolve("test-pg/workers.ts"),
            "cloudflare:test": resolve("test-pg/test.ts"),
            "drizzle-orm/d1": resolve("test-pg/d1.ts"),
          },
        },
        test: {
          name: "postgres",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: POSTGRES_EXCLUDE,
          setupFiles: [
            "./test-pg/scheduler.ts",
            "./test-pg/fresh.ts",
            "./test/apply-migrations.ts",
          ],
          isolate: false,
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test-node/**/*.test.ts"],
          globalSetup: ["./test-node/pglite-cluster.ts"],
          testTimeout: SHARED_RUNNER_TIMEOUT,
          hookTimeout: SHARED_RUNNER_TIMEOUT,
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { "@": resolve("web/src") } },
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["web/src/test-setup.ts"],
          testTimeout: SHARED_RUNNER_TIMEOUT,
        },
      },
    ],
  },
});

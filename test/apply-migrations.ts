import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// No test reaches the network: a test that expects a request mocks fetch
// itself (a later spyOn replaces this implementation).
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off in tests"));
});

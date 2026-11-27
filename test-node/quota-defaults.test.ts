import { describe, expect, it } from "vitest";
import { unstable_readConfig as readConfig } from "wrangler";
import { bindingsFrom } from "../src/node/env.js";

const quotas = [
  "GATEWAY_DAILY_CALLS",
  "REVIEW_DAILY_UPLOADS",
  "REVIEW_MAX_FINDINGS",
  "DEVICE_DAILY_CODES_PER_NETWORK",
  "DEVICE_DAILY_CODES",
] as const;

const worker = readConfig({ config: "wrangler.jsonc" }).vars;
const signIn = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  SESSION_SECRET: "test-session-secret",
};

describe("self-hosted quotas", () => {
  it.each(quotas)("defaults %s to the deployed Worker setting", (key) => {
    expect(worker[key]).toBeTypeOf("string");
    expect(bindingsFrom(signIn)[key]).toBe(worker[key]);
  });

  it.each(quotas)("lets the environment override only %s", (key) => {
    const override = String(Number(worker[key]) + 1);
    const bindings = bindingsFrom({ ...signIn, [key]: override });
    for (const quota of quotas) {
      expect(bindings[quota], quota).toBe(quota === key ? override : worker[quota]);
    }
  });
});

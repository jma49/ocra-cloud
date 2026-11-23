import { describe, expect, it } from "vitest";
import { bindingsFrom, startWarnings } from "../src/node/env.js";

// What a self-hosted server warns of at start.

const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  MODEL_ENDPOINTS: JSON.stringify([
    { id: "corp", label: "Corp LLM", base: "https://llm.corp.internal", key: "corp-server-key" },
  ]),
};

describe("start warnings", () => {
  it("warns at start of a server key with no list, and not once a list is set", () => {
    expect(startWarnings(bindingsFrom(VARS))).toEqual(["open_sign_in_with_server_key"]);
    expect(startWarnings(bindingsFrom({ ...VARS, SIGN_IN_ALLOW: "org:acme" }))).toEqual([]);
    const { MODEL_ENDPOINTS: _, ...keyless } = VARS;
    expect(startWarnings(bindingsFrom(keyless))).toEqual([]);
  });
});

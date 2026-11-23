import { describe, expect, it } from "vitest";
import { remoteReviews } from "../src/auto-review/remote.js";
import { appJwt } from "../src/platforms/bot-tokens.js";

// A host that runs no job itself queues hosted reviews for remote runners
// once it has the bot's key, the webhook secret and a runner token; the
// bot's JWT is signed with Web Crypto, which the Worker has.

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

const bytes = (base64url: string) =>
  Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("the ocra bot's App JWT", () => {
  it("is signed on this runtime with the App's key", async () => {
    const { pem, publicKey } = await keyPair();
    const [head = "", body = "", signature = ""] = (await appJwt("42", pem, 1_000_000)).split(".");
    expect(
      await crypto.subtle.verify(
        RSA.name,
        publicKey,
        bytes(signature),
        new TextEncoder().encode(`${head}.${body}`),
      ),
    ).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bytes(body)))).toMatchObject({ iss: "42" });
  });
});

describe("hosted reviews for remote runners", () => {
  const vars = {
    GITHUB_APP_ID: "42",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "hook-secret",
    RUNNER_TOKEN: "runner-token-of-at-least-32-characters",
  };

  it("are on only with the bot's key, the webhook secret and a runner token", () => {
    expect(remoteReviews(vars)).toMatchObject({
      autoReview: { remote: true },
      runnerToken: vars.RUNNER_TOKEN,
      githubWebhookSecret: "hook-secret",
    });
    for (const name of Object.keys(vars)) {
      expect(remoteReviews({ ...vars, [name]: undefined })).toEqual({});
    }
  });

  it("refuse a runner token short enough to guess", () => {
    expect(() => remoteReviews({ ...vars, RUNNER_TOKEN: "short" })).toThrow(/RUNNER_TOKEN/);
  });
});

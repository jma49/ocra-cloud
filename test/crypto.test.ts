import { describe, expect, it } from "vitest";
import { decryptSecret, decryptWithAny, encryptSecret, keyBinding } from "../src/crypto.js";

const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

describe("envelope encryption", () => {
  it("round-trips, and neither stored value contains the secret", async () => {
    const sealed = await encryptSecret(master, "sk-or-v1-secret-value");
    expect(sealed.ciphertext).not.toContain("secret");
    expect(atob(sealed.ciphertext)).not.toContain("secret");
    expect(await decryptSecret(master, sealed)).toBe("sk-or-v1-secret-value");
  });

  it("uses a fresh data key and IV each time", async () => {
    const a = await encryptSecret(master, "same");
    const b = await encryptSecret(master, "same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it("fails with another master key or a tampered ciphertext", async () => {
    const sealed = await encryptSecret(master, "x-secret");
    await expect(decryptSecret(other, sealed)).rejects.toThrow();
    const bytes = atob(sealed.ciphertext);
    const flipped = btoa(
      bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 1),
    );
    await expect(decryptSecret(master, { ...sealed, ciphertext: flipped })).rejects.toThrow();
  });

  it("rejects a master key of the wrong size", async () => {
    await expect(encryptSecret(btoa("short"), "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("master key rotation", () => {
  it("re-wraps a data key so the new master key opens the same ciphertext", async () => {
    const { rewrap } = await import("../src/crypto.js");
    const sealed = await encryptSecret(master, "sk-rotate-me");
    const wrappedKey = await rewrap(master, other, sealed.wrappedKey);
    expect(wrappedKey).not.toBe(sealed.wrappedKey);
    expect(await decryptSecret(other, { ...sealed, wrappedKey })).toBe("sk-rotate-me");
    await expect(decryptSecret(master, { ...sealed, wrappedKey })).rejects.toThrow();
    await expect(rewrap(other, master, sealed.wrappedKey)).rejects.toThrow();
  });

  it("decrypts with the previous key while a rotation is under way", async () => {
    const old = await encryptSecret(master, "sk-old-row");
    const b = keyBinding("acct-1", "openai");
    expect(await decryptWithAny({ current: other, previous: master }, old, b)).toBe("sk-old-row");
    await expect(decryptWithAny({ current: other }, old, b)).rejects.toThrow();
  });
});

describe("a sealed key is bound to its row", () => {
  it("opens only for the account and provider it was sealed for", async () => {
    const mine = keyBinding("acct-1", "openai");
    const sealed = await encryptSecret(master, "sk-bound", mine);
    expect(await decryptWithAny({ current: master }, sealed, mine)).toBe("sk-bound");
    // Moved onto another account's row, or another provider's: it does not open.
    await expect(
      decryptWithAny({ current: master }, sealed, keyBinding("acct-2", "openai")),
    ).rejects.toThrow();
    await expect(
      decryptWithAny({ current: master }, sealed, keyBinding("acct-1", "anthropic")),
    ).rejects.toThrow();
    await expect(decryptSecret(master, sealed)).rejects.toThrow();
  });

  it("still opens a key sealed before binding, until every row is bound", async () => {
    const legacy = await encryptSecret(master, "sk-legacy");
    expect(await decryptWithAny({ current: master }, legacy, keyBinding("a", "openai"))).toBe(
      "sk-legacy",
    );
  });
});

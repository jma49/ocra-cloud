import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

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

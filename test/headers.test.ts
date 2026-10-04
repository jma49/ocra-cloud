import { describe, expect, it } from "vitest";
import { call, signIn } from "./helpers.js";

// Audit S-hard (#15): every API answer carries nosniff, no referrer and a
// CSP that forbids framing, errors and not-found answers included.

const expected = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

describe("API response headers", () => {
  it("are set on success, refusal, not-found and redirect answers", async () => {
    const { auth } = await signIn(1, "octo");
    const answers = await Promise.all([
      call("/api/health"),
      call("/api/me", { auth: auth }),
      call("/api/me"),
      call("/api/nope"),
      call("/api/auth/github/login"),
    ]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 401, 404, 302]);
    for (const res of answers) {
      for (const [name, value] of Object.entries(expected)) {
        expect(res.headers.get(name), name).toBe(value);
      }
    }
  });
});

import { beforeEach, expect, it } from "vitest";
import { call, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);

const afterError = String.raw`Invalid string: must match pattern /^\d{1,15}_[\w-]{1,64}$/`;

it.each([
  ["/api/audit", "after", afterError],
  ["/api/findings", "after", afterError],
  ["/api/notifications/feed", "before", "not a cursor"],
] as const)(
  "%s accepts legacy page cursors and keeps its own error",
  async (path, key, message) => {
    const { auth } = await signIn(1, "a");
    const page = (token: string) => call(`${path}?${key}=${encodeURIComponent(token)}`, { auth });
    for (const token of ["0_a", `123456789012345_${"a_-9".repeat(16)}`]) {
      expect((await page(token)).status, token).toBe(200);
    }
    for (const token of [
      "",
      "1",
      "-1_a",
      "1_",
      "1_a.b",
      "1234567890123456_a",
      `1_${"a".repeat(65)}`,
    ]) {
      const res = await page(token);
      expect(res.status, token).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid_body",
        issues: [{ path: [key], message }],
      });
    }
  },
);

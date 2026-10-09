import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import app from "../src/index.js";
import { DAY } from "../src/time.js";
import { db, request } from "./helpers.js";
import { metered } from "./metered.js";

// Audit C1: anyone may ask for a login code, before signing in, so the
// codes are capped for the whole service, and making one reads no others.
// Its own file: the day's count starts at zero with the file's storage.

/** Asks for a code from an address; the answer and the D1 rows it used. */
async function ask(ip: string, vars: Record<string, string> = {}) {
  const { DB, meter } = metered();
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/device/code", { method: "POST", headers: { "cf-connecting-ip": ip }, json: {} }),
    { ...env, ...vars, DB },
    ctx,
  );
  const body = await res.json();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, ...meter };
}

describe("login codes", () => {
  it("stop past the service's daily cap, from any address, and a refusal writes nothing", async () => {
    const cap = { DEVICE_DAILY_CODES: "2" };
    expect((await ask("192.0.2.10", cap)).status).toBe(200);
    expect((await ask("192.0.2.11", cap)).status).toBe(200);
    expect(await ask("192.0.2.12", cap)).toMatchObject({
      status: 429,
      body: { error: "slow_down" },
      written: 0,
    });
    expect(await db.select().from(schema.deviceCodes).all()).toHaveLength(2);
  });

  it("are made without reading the codes already made", async () => {
    const expired = Array.from({ length: 30 }, (_, i) => ({
      id: `old-${i}`,
      deviceCodeHash: `hash-${i}`,
      userCode: `BCDF-${String(i).padStart(4, "0")}`,
      expiresAt: new Date(Date.now() - DAY),
    }));
    for (let i = 0; i < expired.length; i += 10) {
      await db.insert(schema.deviceCodes).values(expired.slice(i, i + 10));
    }
    const made = await ask("192.0.2.20");
    expect(made.status).toBe(200);
    expect(made.read).toBeLessThan(10);
  });
});

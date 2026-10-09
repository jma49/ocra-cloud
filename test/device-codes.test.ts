import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { network } from "../src/device.js";
import app from "../src/index.js";
import { DAY } from "../src/time.js";
import { db, request } from "./helpers.js";
import { metered } from "./metered.js";

// Audit C1: anyone may ask for a login code, before signing in, so the
// codes are capped per network and for the whole service, and making one
// reads no others.

beforeEach(async () => {
  await db.delete(schema.deviceCodes);
  await db.delete(schema.serviceCounters);
});

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
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body, ...meter };
}

/** A refusal for the rest of the UTC day: told to come back by midnight. */
const tomorrow = (retryAfter: string | null) =>
  Number(retryAfter) > 0 && Number(retryAfter) <= 86_400;

describe("login codes", () => {
  it("stop past the service's daily cap, from any address, and a refusal writes nothing", async () => {
    const cap = { DEVICE_DAILY_CODES: "2" };
    expect((await ask("192.0.2.10", cap)).status).toBe(200);
    expect((await ask("192.0.2.11", cap)).status).toBe(200);
    const refused = await ask("192.0.2.12", cap);
    expect(refused).toMatchObject({ status: 429, body: { error: "slow_down" }, written: 0 });
    expect(tomorrow(refused.retryAfter)).toBe(true);
    expect(await db.select().from(schema.deviceCodes).all()).toHaveLength(2);
    // Past the service's cap, a new network leaves no row of its own.
    const counts = await db.select().from(schema.serviceCounters).all();
    expect(counts).toHaveLength(3);
  });

  it("stop past a network's daily cap, for that network only, and keep no address", async () => {
    const cap = { DEVICE_DAILY_CODES_PER_NETWORK: "2" };
    expect((await ask("198.51.100.7", cap)).status).toBe(200);
    expect((await ask("198.51.100.7", cap)).status).toBe(200);
    const refused = await ask("198.51.100.7", cap);
    expect(refused).toMatchObject({ status: 429, body: { error: "slow_down" }, written: 0 });
    expect(tomorrow(refused.retryAfter)).toBe(true);
    expect((await ask("198.51.100.8", cap)).status).toBe(200);
    // The addresses of one IPv6 /64 are one network.
    expect((await ask("2001:db8:1:2::a", cap)).status).toBe(200);
    expect((await ask("2001:db8:1:2:ffff::b", cap)).status).toBe(200);
    expect((await ask("2001:db8:1:2::c", cap)).status).toBe(429);
    expect((await ask("2001:db8:1:3::a", cap)).status).toBe(200);
    const names = (await db.select().from(schema.serviceCounters).all()).map((r) => r.name);
    expect(names.join(" ")).not.toMatch(/198\.51|2001/);
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

describe("a network", () => {
  it("is an IPv4 address itself, or an IPv6 address's /64", () => {
    expect(network("203.0.113.9")).toBe("203.0.113.9");
    expect(network("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(network("2001:0db8:0001:0002::6")).toBe("2001:db8:1:2::/64");
    expect(network("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(network("::1")).toBe("0:0:0:0::/64");
  });
});

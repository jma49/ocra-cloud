import { describe, expect, it } from "vitest";
import { clientAddress } from "../src/node/client-address.js";
import { trustedProxyHops } from "../src/node/env.js";

describe("the client's address on a self-hosted server", () => {
  it("is the socket's peer when no proxy is trusted, whatever the headers say", () => {
    expect(clientAddress("198.51.100.7", "203.0.113.1", 0)).toBe("198.51.100.7");
  });

  it("is the entry the outermost trusted proxy appended", () => {
    expect(clientAddress("10.0.0.2", "203.0.113.1, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientAddress("10.0.0.2", "203.0.113.1, 198.51.100.7, 10.0.0.9", 2)).toBe(
      "198.51.100.7",
    );
  });

  it("falls back to the socket when the proxies appended fewer entries than trusted", () => {
    expect(clientAddress("10.0.0.2", "198.51.100.7", 2)).toBe("10.0.0.2");
    expect(clientAddress("10.0.0.2", null, 1)).toBe("10.0.0.2");
  });

  it("reads an IPv4 peer of a dual-stack listener as IPv4", () => {
    expect(clientAddress("::ffff:198.51.100.7", null, 0)).toBe("198.51.100.7");
    expect(clientAddress("::ffff:abcd", null, 0)).toBe("::ffff:abcd");
  });

  it("takes TRUSTED_PROXY_HOPS as a whole number only", () => {
    expect(trustedProxyHops(undefined)).toBe(0);
    expect(trustedProxyHops("2")).toBe(2);
    expect(() => trustedProxyHops("one")).toThrow("TRUSTED_PROXY_HOPS");
  });
});

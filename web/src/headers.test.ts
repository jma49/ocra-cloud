import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import headers from "../public/_headers?raw";
import viteConfig from "../vite.config.ts?raw";

// Audit S-hard (#15): the web app is served with a CSP that forbids framing
// and inline code, nosniff and no referrer (Workers static assets read
// web/public/_headers).

function rules(path = "/*"): Map<string, string> {
  const out = new Map<string, string>();
  let inAll = false;
  for (const raw of headers.split("\n")) {
    if (raw.startsWith("#") || raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      inAll = raw.trim() === path;
      continue;
    }
    if (!inAll) continue;
    const at = raw.indexOf(":");
    out.set(raw.slice(0, at).trim().toLowerCase(), raw.slice(at + 1).trim());
  }
  return out;
}

function csp(): Map<string, string[]> {
  const policy = rules().get("content-security-policy") ?? "";
  return new Map(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name as string, values]),
  );
}

describe("web app headers", () => {
  // Vite inlines assets under 4 KB as data: URLs by default; the CSP's
  // font-src and img-src allow 'self' only, so an inlined font was blocked.
  it("serve every asset from 'self', never inlined as a data: URL", () => {
    expect(csp().get("font-src")).toEqual(["'self'"]);
    expect(viteConfig).toMatch(/assetsInlineLimit:\s*0\b/);
  });
  it("keep the build's content-named files without asking again, and nothing else", () => {
    expect(rules("/assets/*").get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(rules().get("cache-control")).toBeUndefined();
  });
  it("send nosniff and no referrer on every path", () => {
    expect(rules().get("x-content-type-options")).toBe("nosniff");
    expect(rules().get("referrer-policy")).toBe("no-referrer");
  });

  it("keep the app on HTTPS, without powerful features or a cross-origin opener (audit C8)", () => {
    expect(rules().get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(rules().get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(rules().get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("forbid framing and inline or evaluated code", () => {
    const policy = csp();
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    for (const name of ["default-src", "script-src", "style-src"]) {
      const values = policy.get(name) ?? [];
      expect(values, name).toContain("'self'");
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
    }
  });

  it("the page itself has no inline script or style", () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(indexHtml).not.toMatch(/<style|\sstyle=/);
  });
});

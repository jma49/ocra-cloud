import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import headers from "../public/_headers?raw";

// Audit S-hard (#15): the web app is served with a CSP that forbids framing
// and inline code, nosniff and no referrer (Workers static assets read
// web/public/_headers).

function rules(): Map<string, string> {
  const out = new Map<string, string>();
  let inAll = false;
  for (const raw of headers.split("\n")) {
    if (raw.startsWith("#") || raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      inAll = raw.trim() === "/*";
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
  it("send nosniff and no referrer on every path", () => {
    expect(rules().get("x-content-type-options")).toBe("nosniff");
    expect(rules().get("referrer-policy")).toBe("no-referrer");
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

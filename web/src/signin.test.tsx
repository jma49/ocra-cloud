import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SignIn } from "./signin.js";

// The sign-in screen offers the ways this deployment signs people in, so a
// self-hosted server with only its company's SSO shows no GitHub button.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("offers only the deployment's own sign-in, and comes back to the page", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      String(input).endsWith("/auth/methods")
        ? Response.json({ methods: [{ id: "oidc", name: "Example SSO" }] })
        : Response.json({ providers: [] }),
    ),
  );
  render(<SignIn next="/device?code=BCDF-GHJK" />);
  const link = await screen.findByRole("link", { name: /Continue with Example SSO/ });
  expect(link.getAttribute("href")).toBe("/api/auth/oidc/login?next=%2Fdevice%3Fcode%3DBCDF-GHJK");
  expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
});

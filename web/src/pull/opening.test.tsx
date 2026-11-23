import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PullPage } from "../pages/PullPage.js";
import { ToastProvider } from "../toast.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () =>
  render(
    <ToastProvider>
      <PullPage platform="github" repo="octo/api" number="7" />
    </ToastProvider>,
  );

it("says a pull request it cannot find is not here, with the way back, not a retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "not_found" }, { status: 404 })),
  );
  open();
  expect(await screen.findByText("This pull request is not here")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to inbox" }).getAttribute("href")).toBe("/");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("offers to try again when reading it failed for another reason", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "internal" }, { status: 500 })),
  );
  open();
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
});

it("holds the page's head and overview while it reads, under the repository and number", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const { container } = open();
  expect(screen.getByRole("heading", { name: "octo/api #7", level: 1 })).toBeTruthy();
  expect(container.querySelector(".pull-head")).toBeTruthy();
  expect(container.querySelector(".pull-overview .pull-rail")).toBeTruthy();
});

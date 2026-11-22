import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PullReadinessView } from "../../../src/shared/index.js";
import { ReadinessBox } from "./readiness-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };

it("lists each requirement with its state, and hides when the pull request is closed", async () => {
  const view: PullReadinessView = {
    ...pull,
    platform: "github",
    state: "open",
    head: HEAD,
    ready: "unmet",
    items: [
      { kind: "approvals", state: "unmet", detail: "1 of 2 required approvals" },
      { kind: "threads", state: "met", detail: "No unresolved threads" },
      { kind: "required_checks", state: "unknown", detail: "The token cannot read" },
    ],
    codeOwners: [],
    staleApprovals: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(view)),
  );
  render(<ReadinessBox pull={pull} head={HEAD} />);
  expect(await screen.findByText("Not ready")).toBeTruthy();
  expect(screen.getByText("1 of 2 required approvals")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Not met" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Unknown" })).toBeTruthy();
  cleanup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...view, state: "merged", ready: null, items: [] })),
  );
  const { container } = render(<ReadinessBox pull={pull} head={HEAD} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(container.textContent).toBe("");
});

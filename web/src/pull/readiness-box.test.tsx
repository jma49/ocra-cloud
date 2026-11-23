import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PullReadinessView } from "../../../src/shared/index.js";
import { ReadinessBox, useReadiness } from "./readiness-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };

const Box = () => <ReadinessBox view={useReadiness(pull, HEAD)} />;

const serve = (answer: PullReadinessView) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(answer)),
  );

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
    otherRules: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(view)),
  );
  render(<Box />);
  expect(await screen.findByText("Not ready")).toBeTruthy();
  expect(screen.getByText("1 of 2 required approvals")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Not met" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Cannot be read" })).toBeTruthy();
  expect(screen.getByText("1 of 3 met, 1 not readable with your sign-in")).toBeTruthy();
  // What is in the way leads; what is met folds under its count.
  expect(screen.getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Not met",
    "Cannot be read",
    "Met",
  ]);
  expect(screen.getByText("No unresolved threads").closest("details")?.open).toBe(false);
  cleanup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...view, state: "merged", ready: null, items: [] })),
  );
  const { container } = render(<Box />);
  await new Promise((r) => setTimeout(r, 20));
  expect(container.textContent).toBe("");
});

it("stays calm when the rest cannot be read, and names owner groups and stale approvals", async () => {
  serve({
    ...pull,
    platform: "github",
    state: "open",
    head: HEAD,
    ready: "unknown",
    items: [
      { kind: "approvals", state: "met", detail: "Approved" },
      { kind: "code_owners", state: "unknown", detail: "Owners cannot all be read" },
    ],
    codeOwners: [
      { owners: ["@octo/core"], files: 2, state: "met", approvedBy: ["ada"], required: true },
      { owners: ["@octo/ops"], files: 1, state: "unknown", approvedBy: [], required: null },
    ],
    staleApprovals: ["grace"],
    otherRules: ["merge_queue", "required_signatures", "pull_request_title"],
  });
  render(<Box />);
  expect((await screen.findByText("Nothing in the way")).className).toBe("badge");
  expect(screen.getByText("approved by ada, 2 files")).toBeTruthy();
  expect(screen.getByText("cannot be read, 1 file")).toBeTruthy();
  expect(screen.getByText("Approved an earlier head: grace")).toBeTruthy();
  expect(
    screen.getByText(
      "Also required by branch rules: a merge queue, signed commits, pull request title",
    ),
  ).toBeTruthy();
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Findings } from "./Findings.js";
import { Reviews } from "./Reviews.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answers = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
const none = { days: 30, summary: {}, reviewers: {}, reviews: [] };

describe("a console with no reviews yet", () => {
  it("leads to auto review where the server runs reviews", async () => {
    answers(none);
    render(<Reviews runner />);
    expect(await screen.findByText("No reviews in the last 30 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up auto review" }).getAttribute("href")).toBe(
      "/auto-review",
    );
  });

  it("names only the CLI where it does not", async () => {
    answers(none);
    render(<Reviews />);
    expect(await screen.findByText("No reviews in the last 30 days")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up auto review" })).toBeNull();
  });

  it("says where findings come from, by what the server can do", async () => {
    answers({ findings: [], counts: {}, repositories: [] });
    const page = render(<Findings runner />);
    expect(await screen.findByRole("link", { name: "Set up auto review" })).toBeTruthy();
    page.unmount();
    render(<Findings />);
    expect(await screen.findByRole("link", { name: "Open settings" })).toBeTruthy();
  });
});

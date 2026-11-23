import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { rememberQueue } from "./queue.js";
import { QueueNav } from "./queue-nav.js";

afterEach(() => {
  cleanup();
  rememberQueue([]);
});

const paths = ["/pull/github/octo%2Fapi/7", "/pull/github/octo%2Fapi/8", "/pull/gitlab/g%2Fp/3"];

describe("a pull request's place in the inbox", () => {
  it("names where it stands and links the ones beside it, however the path is spelled", () => {
    rememberQueue(paths);
    render(<QueueNav path="/pull/github/octo/api/8" />);
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Previous pull request" }).getAttribute("href")).toBe(
      paths[0],
    );
    expect(screen.getByRole("link", { name: "Next pull request" }).getAttribute("href")).toBe(
      paths[2],
    );
  });

  it("offers no step past either end, and nothing for a pull request the inbox did not show", () => {
    rememberQueue(paths);
    const first = render(<QueueNav path={paths[0] ?? ""} />);
    expect(screen.queryByRole("link", { name: "Previous pull request" })).toBeNull();
    expect(screen.getByRole("link", { name: "Next pull request" })).toBeTruthy();
    first.unmount();
    const { container } = render(<QueueNav path="/pull/github/octo%2Fapi/99" />);
    expect(container.innerHTML).toBe("");
  });
});

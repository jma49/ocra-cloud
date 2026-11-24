import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinkedTasks } from "./review-linked-tasks.js";

afterEach(cleanup);

const list = (tasks: Parameters<typeof LinkedTasks>[0]["tasks"]) =>
  render(
    <dl>
      <LinkedTasks tasks={tasks} />
    </dl>,
  );

describe("a review's linked tasks", () => {
  it("links each task, with its tracker, state and, when shared, its title", () => {
    list([
      {
        tracker: "github",
        key: "#12",
        url: "https://github.com/acme/payments/issues/12",
        state: "open",
        title: "Refuse expired tokens",
      },
      { tracker: "jira", key: "PAY-7", state: "closed" },
      null,
    ]);
    const link = screen.getByRole("link", { name: "#12" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/payments/issues/12");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByText("Refuse expired tokens")).toBeTruthy();
    expect(screen.getByText("PAY-7")).toBeTruthy();
    expect(screen.getByText("Jira")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("says none were linked when the review looked, and shows nothing when it did not", () => {
    list([]);
    expect(screen.getByText("None")).toBeTruthy();
    cleanup();
    const { container } = list(null);
    expect(container.textContent).toBe("");
  });
});

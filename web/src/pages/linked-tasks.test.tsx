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

  it("takes no row when no task was linked, or the review did not look", () => {
    expect(list([]).container.textContent).toBe("");
    cleanup();
    expect(list(null).container.textContent).toBe("");
  });
});

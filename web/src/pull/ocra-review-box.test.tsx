import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OcraReviewBox } from "./ocra-review-box.js";

afterEach(cleanup);

const HEAD = "a".repeat(40);
const review = (current: boolean, complete = true) => ({
  id: "r1",
  head: current ? HEAD : "b".repeat(40),
  current,
  complete,
  createdAt: new Date().toISOString(),
});

it("says where ocra's review stands, and leads into it", () => {
  render(<OcraReviewBox review={review(true)} open={2} />);
  expect(screen.getByText("2 open findings on the diff below.")).toBeTruthy();
  expect(screen.getByText("Reviewed").className).toContain("badge-ok");
  expect(screen.getByText(/ocra reviewed this head/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open the review" }).getAttribute("href")).toBe(
    "/reviews/r1",
  );
  cleanup();
  render(<OcraReviewBox review={review(false)} open={2} />);
  expect(screen.queryByText(/on the diff below/)).toBeNull();
  expect(screen.getByText("Out of date")).toBeTruthy();
  expect(screen.getByText(/of bbbbbbb, before the latest commits/)).toBeTruthy();
});

it("says how a review gets here when there is none, and nothing until that is known", () => {
  const { container } = render(<OcraReviewBox review={undefined} />);
  expect(container.textContent).toBe("");
  cleanup();
  render(<OcraReviewBox review={null} />);
  expect(screen.getByText(/Not reviewed yet/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("leaves the wording to the server's runner where there is one", () => {
  render(
    <OcraReviewBox review={review(true)}>
      <span>ocra reviewed this head, asked 2m ago.</span>
    </OcraReviewBox>,
  );
  expect(screen.getAllByText(/ocra reviewed this head/)).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Open the review" })).toBeTruthy();
});

it("never calls a review that left files unreviewed a review of the head", () => {
  render(<OcraReviewBox review={review(true, false)} />);
  expect(screen.getByText("Incomplete").className).toBe("badge badge-warn");
  expect(screen.queryByText("Reviewed")).toBeNull();
  expect(screen.getByText(/left files unreviewed, so it is not a pass/)).toBeTruthy();
  expect(screen.queryByText(/ocra reviewed this head/)).toBeNull();
  expect(screen.getByRole("link", { name: "Open the review" })).toBeTruthy();
});

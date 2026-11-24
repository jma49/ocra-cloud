import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullPeopleView, PullReviewer } from "../../../src/shared/index.js";
import { REVIEWERS_ID } from "./people.js";
import { ReviewerStack } from "./reviewer-stack.js";

afterEach(cleanup);

const view = (reviewers: PullReviewer[], teams: PullPeopleView["teams"] = []): PullPeopleView => ({
  platform: "github",
  repo: "octo/api",
  number: 7,
  author: "sample-user",
  reviewers,
  teams,
  assignees: [],
  truncated: false,
});

describe("the reviewers on a pull request's head", () => {
  it("shows three marks, then how many more, and names where each stands", () => {
    render(
      <ReviewerStack
        view={view(
          [
            { login: "lead", state: "requested" },
            { login: "dba", state: "approved" },
            { login: "sre", state: "changes_requested" },
            { login: "docs", state: "commented" },
          ],
          [{ slug: "core", name: "octo/core" }],
        )}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Reviewers: lead, asked; dba, approved; sre, changes requested; docs, commented; octo/core, team asked",
    });
    expect(button.querySelectorAll(".reviewer-mark")).toHaveLength(3);
    expect(button.textContent).toBe("LDS+2");
  });

  it("adds no count up to three, and shows nothing when no one is asked", () => {
    const { rerender } = render(
      <ReviewerStack view={view([{ login: "dba", state: "approved" }])} />,
    );
    expect(screen.getByRole("button", { name: "Reviewers: dba, approved" }).textContent).toBe("D");
    rerender(<ReviewerStack view={view([])} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ReviewerStack view={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leads to the rail's reviewers and puts the keys there", () => {
    render(
      <>
        <ReviewerStack view={view([{ login: "dba", state: "approved" }])} />
        <section id={REVIEWERS_ID} tabIndex={-1} aria-label="Reviewers and assignees" />
      </>,
    );
    const section = screen.getByRole("region", { name: "Reviewers and assignees" });
    const scrolled = vi.fn();
    section.scrollIntoView = scrolled;
    fireEvent.click(screen.getByRole("button", { name: /^Reviewers:/ }));
    expect(scrolled).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(section);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Proposals } from "./learnings/proposals.js";

afterEach(cleanup);

const proposal = (number: number, autoMerge: boolean, reviewers: string[]) => ({
  number,
  title: `chore(ocra): add learnings ${number}`,
  url: `https://github.com/octo/api/pull/${number}`,
  branch: `ocra/learnings-${number}`,
  head: "a".repeat(40),
  author: "ocra-bot",
  createdAt: new Date().toISOString(),
  autoMerge,
  reviewers,
  learnings: [],
  invalid: [],
  removed: [],
});

describe("the proposed learnings", () => {
  it("say what each pull request waits for", () => {
    render(
      <Proposals
        data={{ more: false, proposals: [proposal(5, true, ["lena"]), proposal(6, false, [])] }}
      />,
    );
    expect(
      screen.getByText(
        "Merges on its own once its checks and required reviews pass · review requested from lena",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Waits for a person to merge it")).toBeTruthy();
  });
});

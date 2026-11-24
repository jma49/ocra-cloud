import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { EarlierFindingView } from "../../../src/shared/index.js";
import { EarlierFindings } from "./earlier-findings.js";

afterEach(cleanup);

const finding = (over: Partial<EarlierFindingView>): EarlierFindingView => ({
  id: "f1",
  review: "r1",
  severity: "warning",
  title: "Unchecked index",
  body: "",
  file: "src/a.ts",
  lineStart: 4,
  lineEnd: 6,
  hasFix: false,
  lowConfidence: false,
  head: "d".repeat(40),
  outdated: false,
  ...over,
});

it("folds earlier commits' open findings, each with where it was and whether it is outdated", () => {
  const { container } = render(
    <EarlierFindings
      findings={[
        finding({}),
        finding({ id: "f2", title: "Gone stale", outdated: true, lineStart: null, lineEnd: null }),
      ]}
    />,
  );
  const details = container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(screen.getByText("From earlier commits: 2 open findings, 1 outdated")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Unchecked index" }).getAttribute("href")).toBe(
    "/reviews/r1",
  );
  expect(screen.getByText("src/a.ts:4–6 · ddddddd")).toBeTruthy();
  expect(screen.getByText("src/a.ts · ddddddd")).toBeTruthy();
  expect(screen.getAllByText("Outdated")).toHaveLength(1);
});

it("draws nothing when there are none", () => {
  const { container } = render(<EarlierFindings findings={[]} />);
  expect(container.textContent).toBe("");
});

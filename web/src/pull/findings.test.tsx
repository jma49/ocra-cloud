import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PullFindingView } from "../../../src/shared/index.js";
import { FileDiff } from "./file-diff.js";

afterEach(cleanup);

const PATCH = [
  "@@ -10,2 +10,3 @@",
  " const left = captured;",
  "+log(amount);",
  " refund(amount);",
].join("\n");
const file = {
  path: "src/refund.ts",
  oldPath: "src/refund.ts",
  status: "modified" as const,
  additions: 1,
  deletions: 0,
  patch: PATCH,
  viewed: false,
};
const finding = (over: Partial<PullFindingView>): PullFindingView => ({
  id: "f1",
  severity: "warning",
  title: "Logs the amount",
  body: "The amount is `personal data`.",
  file: "src/refund.ts",
  lineStart: 11,
  lineEnd: 11,
  hasFix: false,
  ...over,
});

const show = (findings: PullFindingView[], review: string | null = "r1") =>
  render(
    <FileDiff
      file={file}
      viewed={false}
      onViewed={() => undefined}
      pending={[]}
      onComment={() => undefined}
      onDrop={() => undefined}
      findings={findings}
      review={review}
      onDecided={() => undefined}
      fixes={[]}
      onFixDone={() => undefined}
    />,
  );

it("draws a finding under the line it ends on, and one off the diff at its top", () => {
  show([finding({}), finding({ id: "f2", title: "No test", lineStart: null, lineEnd: null })]);
  const rows = [...document.querySelectorAll("tr")].map((r) => r.textContent ?? "");
  const at = (text: string) => rows.findIndex((r) => r.includes(text));
  expect(at("No test")).toBe(0);
  expect(at("Logs the amount")).toBe(at("log(amount);") + 1);
  const note = within(screen.getByRole("region", { name: "ocra's finding: Logs the amount" }));
  expect(note.getByText("Warning")).toBeTruthy();
  expect(note.getByText("personal data").tagName).toBe("CODE");
  expect(note.getByRole("link", { name: "Open in the review" }).getAttribute("href")).toBe(
    "/reviews/r1",
  );
});

it("draws none without the review they are of", () => {
  show([finding({})], null);
  expect(screen.queryByText("Logs the amount")).toBeNull();
});

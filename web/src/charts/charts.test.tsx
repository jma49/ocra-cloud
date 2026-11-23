import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BarList } from "./bar-list.js";
import { DayChart } from "./day-chart.js";
import { niceMax, stepKey } from "./scale.js";

afterEach(cleanup);

describe("the scale", () => {
  it("rounds the top gridline up to a number that reads well", () => {
    expect([0, 3, 7, 12, 230, 0.4].map(niceMax)).toEqual([1, 5, 10, 20, 250, 0.5]);
  });

  it("steps through the days with the arrow keys, from the newest", () => {
    expect(stepKey("ArrowLeft", null, 7)).toBe(6);
    expect(stepKey("ArrowLeft", 6, 7)).toBe(5);
    expect(stepKey("ArrowRight", 6, 7)).toBe(6);
    expect(stepKey("Home", 3, 7)).toBe(0);
    expect(stepKey("a", 3, 7)).toBeNull();
  });
});

describe("a chart per day", () => {
  const chart = () =>
    render(
      <DayChart
        label="Findings per day"
        kind="bars"
        days={["2026-11-21", "2026-11-22", "2026-11-23"]}
        format={String}
        series={[
          { name: "Critical", color: "var(--red)", values: [1, 0, 2] },
          { name: "Warning", color: "var(--amber)", values: [0, 3, null] },
        ]}
      />,
    );

  it("is one keyboard stop that reads out each day's values", () => {
    chart();
    const plot = screen.getByRole("slider", { name: "Findings per day" });
    expect(plot.getAttribute("aria-valuetext")).toBe("Nov 23: 2 Critical, none Warning");
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(plot.getAttribute("aria-valuetext")).toBe("Nov 22: 0 Critical, 3 Warning");
  });

  it("shows the picked day's total and every series in its tooltip", () => {
    const { container } = chart();
    fireEvent.focus(screen.getByRole("slider"));
    const tip = container.querySelector(".dchart-tip");
    expect(tip?.textContent).toBe("Nov 232Total2Critical–Warning");
  });

  it("marks each day a line has a value, over the days it has none", () => {
    const { container } = render(
      <DayChart
        label="Review time"
        kind="lines"
        days={["2026-11-21", "2026-11-22", "2026-11-23"]}
        format={String}
        series={[{ name: "p50", color: "var(--c1)", values: [4, null, 6] }]}
      />,
    );
    const marks = container.querySelector(".dchart-marks")?.getAttribute("d") ?? "";
    expect(marks.match(/M/g)).toHaveLength(2);
    expect(container.querySelectorAll(".dchart-line")).toHaveLength(1);
  });

  it("keeps every value in a table", () => {
    chart();
    expect(
      screen.getByRole("table", { name: "Findings per day" }).querySelectorAll("tbody tr"),
    ).toHaveLength(3);
  });
});

describe("a bar list", () => {
  it("names each bar and says its value in words", () => {
    render(
      <BarList
        label="Why findings were dismissed"
        max={4}
        rows={[{ key: "fp", label: "False positive", value: 3, text: "75% · 3" }]}
      />,
    );
    const list = screen.getByRole("list", { name: "Why findings were dismissed" });
    expect(list.textContent).toBe("False positive75% · 3");
  });
});

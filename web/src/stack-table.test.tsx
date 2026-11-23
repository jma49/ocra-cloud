import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StackTable } from "./stack-table.js";

let notify: () => void = () => {};
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fit: () => void) {
        notify = fit;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sized(card: { width: number }, table: { width: number }) {
  const { container } = render(
    <StackTable>
      <table>
        <tbody>
          <tr>
            <td>One</td>
          </tr>
        </tbody>
      </table>
    </StackTable>,
  );
  const wrap = container.querySelector(".table-wrap") as HTMLElement;
  Object.defineProperty(wrap, "clientWidth", { get: () => card.width });
  Object.defineProperty(wrap.querySelector("table"), "offsetWidth", { get: () => table.width });
  return wrap;
}

it("stacks once the table outgrows its card and lays it out again when the card can hold it", () => {
  const card = { width: 1000 };
  const table = { width: 1000 };
  const wrap = sized(card, table);
  act(() => notify());
  expect(wrap.hasAttribute("data-stacked")).toBe(false);

  card.width = 700;
  table.width = 912;
  act(() => notify());
  expect(wrap.hasAttribute("data-stacked")).toBe(true);

  // Stacked, the table fits the card, which is no reason to lay it out again.
  table.width = 700;
  card.width = 900;
  act(() => notify());
  expect(wrap.hasAttribute("data-stacked")).toBe(true);

  card.width = 912;
  act(() => notify());
  expect(wrap.hasAttribute("data-stacked")).toBe(false);
});

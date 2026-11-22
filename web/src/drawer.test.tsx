import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Drawer } from "./drawer.js";

afterEach(cleanup);

it("names its dialog and form, submits from the foot, and closes on Escape, the scrim or Close", () => {
  const onClose = vi.fn();
  const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  const { container } = render(
    <Drawer
      title="New rule"
      onClose={onClose}
      onSubmit={onSubmit}
      foot={<button type="submit">Add rule</button>}
    >
      <input aria-label="Rule name" />
    </Drawer>,
  );
  const dialog = screen.getByRole("dialog", { name: "New rule" });
  const form = within(dialog).getByRole("form", { name: "New rule" });
  expect(within(form).getByLabelText("Rule name")).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(document.querySelector(".scrim") as Element);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(3);
  // Inside a sticky column it would stack under the top bar.
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.parentElement).toBe(document.body);
});

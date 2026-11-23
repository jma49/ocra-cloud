import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Drawer } from "./drawer.js";

afterEach(cleanup);

function Host(props: { open: boolean }) {
  return (
    <>
      <button type="button">Open</button>
      {props.open && (
        <Drawer
          title="New rule"
          onClose={() => undefined}
          foot={<button type="submit">Add</button>}
        >
          <input aria-label="Rule name" />
        </Drawer>
      )}
    </>
  );
}

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

it("takes focus to its first field, keeps Tab inside, and gives focus back when it closes", () => {
  const page = render(<Host open={false} />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  page.rerender(<Host open />);
  const field = screen.getByLabelText("Rule name");
  expect(document.activeElement).toBe(field);

  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.keyDown(add, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(add);

  page.rerender(<Host open={false} />);
  expect(document.activeElement).toBe(opener);
});

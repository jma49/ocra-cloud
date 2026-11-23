import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { usePageCommands } from "../page-commands.js";
import { useGlobalKeys } from "./global-keys.js";
import { ShortcutsDrawer } from "./shortcuts-drawer.js";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key });

function Console() {
  const [open, setOpen] = useState(false);
  useGlobalKeys(() => setOpen(true));
  usePageCommands("Inbox", [{ label: "Next pull request", key: "j", run: () => {} }]);
  return (
    <>
      <button type="button">Somewhere</button>
      <input aria-label="A field" />
      {open && <ShortcutsDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

describe("keys that hold everywhere", () => {
  it("? lists the open page's keys and the ones that hold everywhere", () => {
    render(<Console />);
    const before = screen.getByRole("button", { name: "Somewhere" });
    before.focus();
    press("?", before);
    const panel = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const page = within(panel).getByRole("region", { name: "Inbox" });
    expect(page.textContent).toBe("InboxNext pull requestj");
    expect(within(panel).getByRole("region", { name: "Go to" }).textContent).toContain(
      "Findingsgf",
    );

    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("g then a place's letter goes there, but not while typing or once the moment passed", () => {
    render(<Console />);
    press("g", screen.getByLabelText("A field"));
    press("f", screen.getByLabelText("A field"));
    expect(location.pathname).toBe("/");
    press("g");
    press("f");
    expect(location.pathname).toBe("/findings");
    press("f");
    expect(location.pathname).toBe("/findings");
  });
});

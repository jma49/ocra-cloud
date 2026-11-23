import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandMenu } from "./command-menu.js";
import { type PageCommand, usePageCommands } from "./page-commands.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Page(props: { commands: PageCommand[] }) {
  usePageCommands("This pull request", props.commands);
  return <input aria-label="A field" />;
}

describe("a page's commands", () => {
  it("run on their key, but not while typing or with a modifier held", () => {
    const run = vi.fn();
    render(<Page commands={[{ label: "Review changes", key: "r", run }]} />);
    fireEvent.keyDown(screen.getByLabelText("A field"), { key: "r" });
    fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    fireEvent.keyDown(document.body, { key: "x" });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "r" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lead the command menu with their key while the page is open, and run from it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    const run = vi.fn();
    const page = render(<Page commands={[{ label: "Review changes", key: "r", run }]} />);
    render(
      <CommandMenu
        sections={[{ value: "Inbox", items: [{ label: "Inbox", to: "/", within: "Inbox" }] }]}
      />,
    );
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const option = await screen.findByRole("option", { name: /Review changes/ });
    expect(screen.getAllByRole("option")[0]).toBe(option);
    expect(option.textContent).toBe("Review changesr");
    fireEvent.click(option);
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    page.unmount();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("option", { name: "Inbox" });
    expect(screen.queryByRole("option", { name: /Review changes/ })).toBeNull();
  });
});

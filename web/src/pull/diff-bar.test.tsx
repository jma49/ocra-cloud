import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiffBar } from "./diff-bar.js";
import { useDiffLayout, useDiffWhitespace, useDiffWrap } from "./diff-layout.js";

// How diffs are drawn, chosen in one menu over them and kept in this browser.

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function Bar() {
  const layout = useDiffLayout();
  return (
    <DiffBar layout={layout} wrap={useDiffWrap(layout.narrow)} whitespace={useDiffWhitespace()} />
  );
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Diff settings" }));
const checked = (el: HTMLElement) => el.getAttribute("aria-checked");

it("gathers the layout, whitespace and wrapping in one menu", async () => {
  render(<Bar />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  open();
  expect(checked(await screen.findByRole("menuitemradio", { name: "Unified" }))).toBe("true");
  expect(checked(screen.getByRole("menuitemradio", { name: "Split" }))).toBe("false");
  const whitespace = screen.getByRole("menuitemcheckbox", { name: "Hide whitespace" });
  expect(checked(whitespace)).toBe("false");
  expect(whitespace.getAttribute("aria-keyshortcuts")).toBe("w");
  expect(checked(screen.getByRole("menuitemcheckbox", { name: "Wrap lines" }))).toBe("true");
});

it("draws diffs split and back, kept in this browser", async () => {
  const { unmount } = render(<Bar />);
  open();
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Split" }));
  expect(localStorage.getItem("ocra-diff-layout")).toBe("split");
  expect(checked(screen.getByRole("menuitemradio", { name: "Split" }))).toBe("true");
  unmount();
  render(<Bar />);
  open();
  expect(checked(await screen.findByRole("menuitemradio", { name: "Split" }))).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Unified" }));
  expect(localStorage.getItem("ocra-diff-layout")).toBe("unified");
});

it("hides whitespace-only changes, kept in this browser", async () => {
  const { unmount } = render(<Bar />);
  open();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Hide whitespace" }));
  expect(localStorage.getItem("ocra-diff-whitespace")).toBe("hide");
  unmount();
  render(<Bar />);
  open();
  const item = await screen.findByRole("menuitemcheckbox", { name: "Hide whitespace" });
  expect(checked(item)).toBe("true");
  fireEvent.click(item);
  expect(localStorage.getItem("ocra-diff-whitespace")).toBe("show");
});

it("stops wrapping long lines, kept in this browser", async () => {
  const { unmount } = render(<Bar />);
  open();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Wrap lines" }));
  expect(localStorage.getItem("ocra-diff-wrap")).toBe("off");
  unmount();
  render(<Bar />);
  open();
  expect(checked(await screen.findByRole("menuitemcheckbox", { name: "Wrap lines" }))).toBe(
    "false",
  );
});

it("offers a phone only whitespace, since it always draws diffs unified and wrapped", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  localStorage.setItem("ocra-diff-layout", "split");
  render(<Bar />);
  open();
  await screen.findByRole("menuitemcheckbox", { name: "Hide whitespace" });
  expect(screen.queryByRole("menuitemradio")).toBeNull();
  expect(screen.queryByRole("menuitemcheckbox", { name: "Wrap lines" })).toBeNull();
});

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationItem } from "./conversation.js";
import { ConversationColumn, useConversationOpen } from "./conversation-column.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const item = (id: string, state: ConversationItem["state"], line: number | null = 3) =>
  ({
    id,
    path: "src/pay/refund.ts",
    line,
    side: "new",
    state,
    author: "ana",
    ocra: false,
    title: `About ${id}`,
    comments: 1,
  }) satisfies ConversationItem;

const ITEMS = [
  item("a", "open"),
  item("b", "open", 9),
  item("c", "outdated", null),
  item("d", "resolved"),
  item("e", "resolved"),
  item("f", "resolved"),
];

const groupOf = (label: string) =>
  [...document.querySelectorAll<HTMLDetailsElement>("details.convo-group")].find((d) =>
    d.querySelector("summary")?.textContent?.startsWith(label),
  );

it("groups the conversations with counts, Resolved folded", () => {
  render(<ConversationColumn items={ITEMS} open onToggle={() => {}} onJump={() => {}} />);
  expect(groupOf("Open")?.querySelector("summary")?.textContent).toBe("Open2");
  expect(groupOf("Outdated")?.querySelector("summary")?.textContent).toBe("Outdated1");
  expect(groupOf("Resolved")?.querySelector("summary")?.textContent).toBe("Resolved3");
  expect(groupOf("Open")?.open).toBe(true);
  expect(groupOf("Outdated")?.open).toBe(true);
  expect(groupOf("Resolved")?.open).toBe(false);
});

it("leads a conversation to its line", () => {
  const onJump = vi.fn();
  render(<ConversationColumn items={ITEMS} open onToggle={() => {}} onJump={onJump} />);
  fireEvent.click(screen.getByText("About b"));
  expect(onJump).toHaveBeenCalledWith(ITEMS[1]);
  expect(screen.getByText("refund.ts:9")).toBeTruthy();
  expect(screen.getByText("refund.ts")).toBeTruthy();
});

it("folds to one button that says how many there are", () => {
  const onToggle = vi.fn();
  render(<ConversationColumn items={ITEMS} open={false} onToggle={onToggle} onJump={() => {}} />);
  expect(screen.queryByText("About a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show conversation (6)" }));
  expect(onToggle).toHaveBeenCalled();
});

it("remembers whether it was open in this browser", () => {
  const first = renderHook(() => useConversationOpen());
  expect(first.result.current.open).toBe(true);
  act(() => first.result.current.toggle());
  expect(first.result.current.open).toBe(false);
  first.unmount();
  const again = renderHook(() => useConversationOpen());
  expect(again.result.current.open).toBe(false);
  act(() => again.result.current.pick(true));
  expect(renderHook(() => useConversationOpen()).result.current.open).toBe(true);
});

it("names ocra as the author of its findings and says when there are none", () => {
  const ocra = { ...item("g", "open"), ocra: true, author: "ocra-bot", title: "Null check" };
  const { unmount } = render(
    <ConversationColumn items={[ocra]} open onToggle={() => {}} onJump={() => {}} />,
  );
  expect(document.querySelector(".convo-title")?.textContent).toBe("ocra Null check");
  unmount();
  render(<ConversationColumn items={[]} open onToggle={() => {}} onJump={() => {}} />);
  expect(screen.getByText("No comments on this diff yet.")).toBeTruthy();
});

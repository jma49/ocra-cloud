import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileComments, FileMenu, fileAtHead } from "./file-menu.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);

describe("fileAtHead", () => {
  it("links the file at the head from a GitHub or GitLab pull request's page", () => {
    expect(fileAtHead("https://github.com/acme/pay/pull/7", HEAD, "src/a b.ts")).toBe(
      `https://github.com/acme/pay/blob/${HEAD}/src/a%20b.ts`,
    );
    expect(
      fileAtHead("https://gitlab.example.com/g/sub/pay/-/merge_requests/12", HEAD, "lib/x.rb"),
    ).toBe(`https://gitlab.example.com/g/sub/pay/-/blob/${HEAD}/lib/x.rb`);
  });

  it("links nothing for another address or a head that is not a commit", () => {
    expect(fileAtHead(null, HEAD, "a.ts")).toBeNull();
    expect(fileAtHead("https://github.com/acme/pay/issues/7", HEAD, "a.ts")).toBeNull();
    expect(fileAtHead("javascript:alert(1)//pull/7", HEAD, "a.ts")).toBeNull();
    expect(fileAtHead("http://github.com/acme/pay/pull/7", HEAD, "a.ts")).toBeNull();
    expect(fileAtHead("https://github.com/acme/pay/pull/7", "main", "a.ts")).toBeNull();
  });
});

it("counts a file's comments and leads to the first", () => {
  const onOpen = vi.fn();
  const { rerender } = render(<FileComments path="a.ts" count={3} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "3 comments on a.ts: go to the first" }));
  expect(onOpen).toHaveBeenCalled();
  rerender(<FileComments path="a.ts" count={0} onOpen={onOpen} />);
  expect(screen.queryByRole("button")).toBeNull();
});

const menu = (over: Partial<Parameters<typeof FileMenu>[0]> = {}) => {
  const props = {
    path: "src/a.ts",
    atHead: `https://github.com/acme/pay/blob/${HEAD}/src/a.ts`,
    viewed: false,
    onViewed: vi.fn(),
    folded: false,
    onFold: vi.fn(),
    ...over,
  };
  render(<FileMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for src/a.ts" }));
  return props;
};

it("copies the file's path", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  menu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/a.ts"));
});

it("links the file at the head, in a new tab", async () => {
  menu();
  const link = await screen.findByRole("menuitem", { name: "View file at head" });
  expect(link.getAttribute("href")).toBe(`https://github.com/acme/pay/blob/${HEAD}/src/a.ts`);
  expect(link.getAttribute("target")).toBe("_blank");
});

it("offers no link where none can be made", async () => {
  menu({ atHead: null });
  await screen.findByRole("menuitem", { name: "Copy path" });
  expect(screen.queryByRole("menuitem", { name: "View file at head" })).toBeNull();
});

it("marks the file viewed and folds it", async () => {
  const props = menu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark viewed" }));
  expect(props.onViewed).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Actions for src/a.ts" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse" }));
  expect(props.onFold).toHaveBeenCalledWith(true);
});

it("offers the other way for a file viewed and folded", async () => {
  cleanup();
  const props = menu({ viewed: true, folded: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark not viewed" }));
  expect(props.onViewed).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Actions for src/a.ts" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Expand" }));
  expect(props.onFold).toHaveBeenCalledWith(false);
});

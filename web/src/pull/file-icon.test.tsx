import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FileTypeIcon } from "./file-icon.js";

afterEach(cleanup);

const src = (name: string, folder = false) => {
  const { container } = render(<FileTypeIcon name={name} folder={folder} />);
  const shown = container.querySelector("img")?.getAttribute("src") ?? "";
  cleanup();
  return shown;
};

it("tells kinds of file apart, the longest ending first, and a name it does not know from none", () => {
  const kinds = ["a.ts", "a.tsx", "a.test.ts", "a.d.ts", "a.css", "a.md", "package.json", "a.json"];
  expect(new Set(kinds.map((k) => src(k))).size).toBe(kinds.length);
  expect(src("A.TS")).toBe(src("a.ts"));
  expect(src("Makefile")).toBe(src("notes.unknown"));
  expect(src("a.ts")).not.toBe(src("notes.unknown"));
});

it("names a joined chain of folders by its last one", () => {
  expect(src("web/src", true)).toBe(src("src", true));
  expect(src("src", true)).not.toBe(src("gateway", true));
  expect(src("ts", true)).toBe(src("gateway", true));
});

it("is decoration: the name beside it says the same", () => {
  const { container } = render(<FileTypeIcon name="a.ts" />);
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
});

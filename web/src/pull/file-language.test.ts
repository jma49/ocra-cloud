import { expect, it } from "vitest";
import { languageName } from "./file-language.js";

it("names a file's language by its extension or its name", () => {
  expect(languageName("src/pull/diff.ts")).toBe("TypeScript");
  expect(languageName("web/App.TSX")).toBe("TSX");
  expect(languageName("api/main.py")).toBe("Python");
  expect(languageName("deploy/Dockerfile")).toBe("Dockerfile");
  expect(languageName("README.md")).toBe("Markdown");
});

it("names none for an unknown kind, a dot file or a name with no extension", () => {
  expect(languageName("assets/logo.png")).toBeNull();
  expect(languageName(".env")).toBeNull();
  expect(languageName("LICENSE")).toBeNull();
  expect(languageName("a/b.constructor")).toBeNull();
  expect(languageName("a/__proto__")).toBeNull();
});

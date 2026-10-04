/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { AGENT_ROLES, REVIEWER_ID } from "../src/contract/index.js";
import { BUILT_IN_REVIEWERS, formatModelId, parseModelId, ROLES } from "../src/shared/index.js";
import webTsconfig from "../web/tsconfig.json?raw";

// One shared domain module (#32): the web app takes the Worker's words and
// shapes only from src/shared/ and the contract, never from the database or
// the Worker's own code; and src/shared/ imports nothing but itself and the
// contract, so the web bundle never pulls in Drizzle. Both take only types
// from the contract: its values come with its schemas and zod.

const web = import.meta.glob(["../web/src/**/*.{ts,tsx}", "!../web/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const shared = import.meta.glob("../src/shared/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const worker = import.meta.glob(["../src/**/*.ts", "!../src/contract/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every relative import of each file, resolved to a path from the repository root. */
function imports(files: Record<string, string>): [string, string][] {
  return Object.entries(files).flatMap(([file, text]) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)].map((m): [string, string] => [
      file.replace("../", ""),
      new URL(m[1] ?? "", `file:///repo/${file.replace("../", "")}`).pathname.slice(6),
    ]),
  );
}

describe("the shared domain module", () => {
  it("is all the web app imports from src/", () => {
    expect(Object.keys(web).length).toBeGreaterThan(20);
    const outside = imports(web).filter(
      ([, to]) =>
        !to.startsWith("web/") && !to.startsWith("src/shared/") && !to.startsWith("src/contract/"),
    );
    expect(outside).toEqual([]);
  });

  it("is the only src/ the web's tsconfig includes", () => {
    const { include } = JSON.parse(webTsconfig) as { include: string[] };
    expect(include.filter((p) => p.startsWith("../"))).toEqual(["../src/shared"]);
  });

  it("imports only itself and the contract", () => {
    expect(Object.keys(shared).length).toBeGreaterThan(3);
    const outside = imports(shared).filter(
      ([, to]) => !to.startsWith("src/shared/") && !to.startsWith("src/contract/"),
    );
    expect(outside).toEqual([]);
    const packages = Object.entries(shared).flatMap(([file, text]) =>
      [...text.matchAll(/from\s*"([^.][^"]*)"/g)].map((m) => `${file}: ${m[1]}`),
    );
    expect(packages).toEqual([]);
  });

  it("brings no contract value into the web bundle", () => {
    const values = Object.entries({ ...shared, ...web }).flatMap(([file, text]) =>
      [
        ...text.matchAll(/(?:^|\n)(?:import|export)\s+(?!type\b)[^;]*?from\s*"[./]*\/contract\//g),
      ].map(() => file),
    );
    expect(values).toEqual([]);
  });

  it("spells out the ocra-<provider>/<model> form alone", () => {
    const spelled = Object.entries({ ...worker, ...web })
      .filter(([file]) => !file.endsWith("/shared/models.ts"))
      .flatMap(([file, text]) =>
        [...text.matchAll(/`ocra-\$\{|["']ocra-["']|\.slice\(5, /g)].map((m) => `${file}: ${m[0]}`),
      );
    expect(spelled).toEqual([]);
  });
});

describe("model ids", () => {
  it("takes an ocra-<provider>/<model> name apart and puts it back", () => {
    expect(parseModelId("ocra-openrouter/qwen/qwen3.8-27b:free")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.8-27b:free",
    });
    expect(formatModelId("openrouter", "qwen/qwen3.8-27b:free")).toBe(
      "ocra-openrouter/qwen/qwen3.8-27b:free",
    );
    // A half-filled row in the web's editor.
    expect(parseModelId("ocra-openai/")).toEqual({ provider: "openai", model: "" });
    expect(formatModelId("openai")).toBe("ocra-openai/");
  });

  it("is null for any other name", () => {
    for (const id of ["openai/gpt-5", "ocra-openai", "ocra/openai/gpt-5", ""]) {
      expect(parseModelId(id)).toBeNull();
    }
  });
});

describe("the engine's agents", () => {
  it("lists every role of the contract, in its order", () => {
    expect(ROLES.map((r) => r.id)).toEqual([...AGENT_ROLES]);
  });

  it("names reviewers as the engine does", () => {
    for (const r of BUILT_IN_REVIEWERS) expect(r.id).toMatch(REVIEWER_ID);
    expect(new Set(BUILT_IN_REVIEWERS.map((r) => r.id)).size).toBe(BUILT_IN_REVIEWERS.length);
  });
});

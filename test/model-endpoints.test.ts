import { describe, expect, it } from "vitest";
import { catalogOf } from "../src/catalog.js";
import { modelEndpoints } from "../src/model-endpoints.js";
import { preferencesBody } from "../src/preferences.js";
import { chatRoute } from "../src/providers.js";

const taken = new Set(["openai"]);
const one = (entry: Record<string, unknown>) => modelEndpoints(JSON.stringify([entry]), taken);

describe("a server's own model endpoints", () => {
  it("become Company providers with an OpenAI chat route by default", () => {
    const found = one({ id: "corp", label: "Corp LLM", base: "https://llm.corp.example/openai/" });
    expect(found.get("corp")).toEqual({
      label: "Corp LLM",
      group: "Company",
      base: "https://llm.corp.example/openai",
      routes: [{ path: "/v1/chat/completions", auth: "bearer" }],
    });
    expect(chatRoute(found.get("corp"))?.wire).toBe("openai");
  });

  it("keep their declared paths, model list and the server's key", () => {
    const found = one({
      id: "corp",
      label: "Corp",
      base: "http://10.0.0.5:8000",
      paths: ["/chat/completions"],
      auth: "x-api-key",
      models: "/models",
      key: "corp-secret",
    });
    expect(found.get("corp")).toMatchObject({
      base: "http://10.0.0.5:8000",
      routes: [{ path: "/chat/completions", auth: "x-api-key" }],
      verify: { path: "/models", auth: "x-api-key" },
      sharedKey: "corp-secret",
    });
  });

  it("are none when unset", () => {
    expect(modelEndpoints(undefined, taken).size).toBe(0);
    expect(modelEndpoints("  ", taken).size).toBe(0);
  });

  it.each([
    ["not JSON", "{", "is not JSON"],
    ["a built-in id", [{ id: "openai", label: "x", base: "https://a.example" }], "built-in"],
    [
      "an id twice",
      [
        { id: "corp", label: "x", base: "https://a.example" },
        { id: "corp", label: "y", base: "https://b.example" },
      ],
      "declared twice",
    ],
    ["an id out of form", [{ id: "Corp", label: "x", base: "https://a.example" }], "id"],
    ["a field it does not know", [{ id: "c", label: "x", base: "https://a.example", k: 1 }], "k"],
    ["a non-http base", [{ id: "c", label: "x", base: "file:///etc" }], "http or https"],
    ["a base with credentials", [{ id: "c", label: "x", base: "https://u:p@a.example" }], "cred"],
    ["a base with a query", [{ id: "c", label: "x", base: "https://a.example/?x=1" }], "query"],
    ["a base that is no URL", [{ id: "c", label: "x", base: "llm" }], "not a URL"],
    [
      "a path leaving the base",
      [{ id: "c", label: "x", base: "https://a.example", paths: ["/v1/../admin"] }],
      "paths",
    ],
  ])("refuse %s", (_what, value, message) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    expect(() => modelEndpoints(raw, taken)).toThrow(message);
  });
});

describe("the deployment's providers", () => {
  const corp = JSON.stringify([{ id: "corp", label: "Corp", base: "https://llm.corp.example" }]);

  it("hold the built-in ones and the server's own", () => {
    const catalog = catalogOf({ MODEL_ENDPOINTS: corp });
    expect(catalog.get("openai")).toBeDefined();
    expect(catalog.get("corp")?.group).toBe("Company");
  });

  it("hold only the server's own when BUILTIN_PROVIDERS is off", () => {
    const catalog = catalogOf({ MODEL_ENDPOINTS: corp, BUILTIN_PROVIDERS: "off" });
    expect(catalog.get("openai")).toBeUndefined();
    expect(catalog.entries.map(([name]) => name)).toEqual(["corp"]);
    expect(() => catalogOf({ BUILTIN_PROVIDERS: "no" })).toThrow("on or off");
  });

  it("decide which default models a save may name", () => {
    const save = { models: { top: ["ocra-corp/qwen3-coder"] } };
    expect(preferencesBody(catalogOf({})).safeParse(save).success).toBe(false);
    expect(preferencesBody(catalogOf({ MODEL_ENDPOINTS: corp })).safeParse(save).success).toBe(
      true,
    );
  });
});

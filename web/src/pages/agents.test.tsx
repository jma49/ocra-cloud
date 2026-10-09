import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../prefs.js";
import { forgetProviders } from "../ui.js";
import { Agents } from "./Agents.js";

afterEach(() => {
  forgetProviders();
  cleanup();
  vi.unstubAllGlobals();
});

const chat = ["/v1/chat/completions"];
const PROVIDERS = ["openai", "openrouter", "deepseek", "groq"].map((name) => ({
  name,
  label: name,
  group: "Major",
  base: `https://${name}.example`,
  paths: chat,
}));
const prefs = { runtime: null, models: {}, agents: {}, settings: {}, version: "v1" };

describe("the Agents page", () => {
  it("asks each keyed provider for its models once, however the answers arrive (#35)", async () => {
    const asked: string[] = [];
    // Answers arrive one after another, each a moment later, as a slow provider's would.
    let delay = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const path = String(input).replace(/^\/api/, "");
        if (path === "/providers") return Response.json({ providers: PROVIDERS });
        if (path === "/preferences") return Response.json(prefs);
        if (path === "/keys")
          return Response.json({ keys: PROVIDERS.map((p) => ({ provider: p.name })) });
        asked.push(path);
        delay += 5;
        await new Promise((r) => setTimeout(r, delay));
        return Response.json({ models: [{ id: "m", efforts: [] }] });
      }),
    );
    render(
      <PrefsProvider>
        <Agents />
      </PrefsProvider>,
    );
    await screen.findByRole("heading", { name: "Agents" });
    await waitFor(() => expect(asked).toHaveLength(PROVIDERS.length));
    await new Promise((r) => setTimeout(r, 100));
    expect(asked.sort()).toEqual(PROVIDERS.map((p) => `/keys/${p.name}/models`).sort());
  });

  it("gives each provider one list of models that every row shares (audit C11)", async () => {
    const chained = {
      ...prefs,
      models: {
        standard: ["ocra-openai/a", "ocra-openai/b"],
        top: ["ocra-openai/c", "ocra-groq/d"],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const path = String(input).replace(/^\/api/, "");
        if (path === "/providers") return Response.json({ providers: PROVIDERS });
        if (path === "/preferences") return Response.json(chained);
        if (path === "/keys")
          return Response.json({ keys: PROVIDERS.map((p) => ({ provider: p.name })) });
        return Response.json({ models: [{ id: "m1", efforts: [] }] });
      }),
    );
    const { container } = render(
      <PrefsProvider>
        <Agents />
      </PrefsProvider>,
    );
    await waitFor(() => expect(container.querySelectorAll("input[list]")).toHaveLength(4));
    const ids = [...container.querySelectorAll("datalist")].map((d) => d.id);
    expect(ids.sort()).toEqual(PROVIDERS.map((p) => `models-${p.name}`).sort());
    for (const input of container.querySelectorAll("input[list]")) {
      expect(ids).toContain(input.getAttribute("list"));
    }
  });
});

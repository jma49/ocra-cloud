import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "../account-keys.js";
import { forgetProviders } from "../ui.js";
import { Keys } from "./Keys.js";

// A provider whose key the server holds (MODEL_ENDPOINTS) next to the user's own.

const providers = [
  {
    name: "corp",
    label: "Corp LLM",
    group: "Company",
    base: "https://llm.corp.example",
    paths: ["/v1/chat/completions"],
    managed: true,
  },
  {
    name: "openai",
    label: "OpenAI",
    group: "Major",
    base: "https://api.openai.com",
    paths: ["/v1/chat/completions"],
  },
];
const used = { lastUsedAt: null, calls7d: 0, checkStatus: null, checkedAt: null };
const keys = [
  { provider: "corp", managed: true, last4: null, createdAt: null, checkable: false, ...used },
  {
    provider: "openai",
    managed: false,
    last4: "abcd",
    createdAt: "2026-10-01T00:00:00Z",
    checkable: true,
    ...used,
  },
];

afterEach(() => {
  forgetProviders();
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
});

describe("the keys page", () => {
  it("shows the server's key as provided, with nothing to replace or delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).endsWith("/providers")
          ? Response.json({ providers })
          : Response.json({ keys }),
      ),
    );
    render(<Keys />);
    const corp = (await screen.findByText("Provided by this server")).closest("tr");
    if (!corp) throw new Error("no row");
    expect(within(corp).queryByRole("button", { name: "Replace" })).toBeNull();
    expect(within(corp).queryByRole("button", { name: "Delete" })).toBeNull();
    const own = screen.getByText("••••abcd").closest("tr");
    if (!own) throw new Error("no row");
    expect(within(own).getByRole("button", { name: "Replace" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ Add key" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByText("Corp LLM")).toBeNull();
    expect(within(drawer).getByText("OpenAI")).toBeTruthy();
  });
});

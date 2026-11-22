import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../prefs.js";
import { Plugins } from "./Plugins.js";
import { ReviewSettings } from "./ReviewSettings.js";

// The configuration pages against a fake /api/preferences.

const saved = {
  runtime: null,
  models: {},
  agents: {},
  settings: {
    maxTasks: 20,
    plugins: ["@acme/rules"],
    pluginSettings: { "@acme/rules": { strict: true } },
  },
  updatedAt: null,
  version: "v1",
};

function fakeApi(delayMs = 0) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return Response.json({ ...body, version: "v2" });
      }
      if (String(input).endsWith("/api/preferences")) {
        await new Promise((r) => setTimeout(r, delayMs));
        return Response.json(saved);
      }
      return Response.json({});
    }),
  );
  return puts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plugins", () => {
  it("Remove takes the plugin out of the list and the saved settings, with its settings", async () => {
    const puts = fakeApi();
    render(
      <PrefsProvider>
        <Plugins />
      </PrefsProvider>,
    );
    await screen.findByText("@acme/rules");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("@acme/rules")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0] as { settings: Record<string, unknown> };
    expect(sent.settings.plugins).toBeUndefined();
    expect(sent.settings.pluginSettings).toBeUndefined();
    expect(sent.settings.maxTasks).toBe(20);
  });
});

describe("Review settings", () => {
  it("shows saved numbers after the settings load, and again after Discard", async () => {
    fakeApi(30);
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const field = (await screen.findByLabelText("Most review tasks")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("20"));
    fireEvent.change(field, { target: { value: "5" } });
    expect(field.value).toBe("5");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await act(async () => {});
    expect(((await screen.findByLabelText("Most review tasks")) as HTMLInputElement).value).toBe(
      "20",
    );
  });
});

describe("The linked-tasks switch", () => {
  it("starts on as the default and saves false when turned off", async () => {
    const puts = fakeApi();
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const toggle = await screen.findByRole("switch", { name: "Give reviewers linked tasks" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ settings: { linkedTasks: false, maxTasks: 20 } });
  });
});

describe("The fixes switch", () => {
  it("starts off as the default and saves true when turned on", async () => {
    const puts = fakeApi();
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const toggle = await screen.findByRole("switch", { name: "Propose fixes" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ settings: { fixes: true, maxTasks: 20 } });
  });
});

describe("Saving from a stale tab", () => {
  it("sends the base version, and on a 409 offers Reload, which drops the draft without a leave prompt", async () => {
    const puts: unknown[] = [];
    let gets = 0;
    const newer = { ...saved, settings: { ...saved.settings, maxTasks: 40 }, version: "v2" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return Response.json({ error: "stale", version: "v2" }, { status: 409 });
        }
        if (String(input).endsWith("/api/preferences")) {
          gets++;
          return Response.json(gets === 1 ? saved : newer);
        }
        return Response.json({});
      }),
    );
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const field = (await screen.findByLabelText("Most review tasks")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("20"));
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ baseVersion: "v1", settings: { maxTasks: 5 } });

    await screen.findByText(/changed in another tab/);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Most review tasks") as HTMLInputElement).value).toBe("40"),
    );
    expect(screen.queryByText(/changed in another tab/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    // Nothing is left to warn about when leaving.
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });
});

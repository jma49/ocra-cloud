import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./chrome.js";
import { ReviewSettings } from "./pages/ReviewSettings.js";
import { type Prefs, PrefsProvider, type Settings, usePrefs } from "./prefs.js";
import { Seg } from "./ui.js";

const saved = {
  runtime: null,
  models: { top: ["ocra-openai/gpt-5"] },
  agents: {},
  settings: { maxTasks: 20, sampling: { seed: 1 } },
  updatedAt: null,
  version: "v1",
};

function fakeApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(saved)),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Sets the draft once the settings load.
function SetDraft(props: { to: (p: Prefs) => Prefs }) {
  const { saved, setDraft } = usePrefs();
  useEffect(() => {
    if (saved) setDraft(props.to(saved));
  }, [saved, setDraft, props.to]);
  return <span>{saved ? "loaded" : ""}</span>;
}

describe("unsaved changes", () => {
  it("key order and undefined values are not changes", async () => {
    fakeApi();
    // Undefined fields are what an edited draft holds, though the type omits them.
    const reorder = (p: Prefs): Prefs =>
      ({
        version: p.version,
        settings: { sampling: { temperature: undefined, seed: 1 }, maxTasks: 20 },
        agents: { effort: undefined },
        models: { top: ["ocra-openai/gpt-5"], light: undefined },
        runtime: null,
      }) as unknown as Prefs;
    render(
      <PrefsProvider>
        <SetDraft to={reorder} />
      </PrefsProvider>,
    );
    await screen.findByText("loaded");
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  it("a real change, or a reordered model chain, still is", async () => {
    fakeApi();
    const change = (p: Prefs): Prefs => ({
      ...p,
      models: { top: ["ocra-openai/gpt-5", "ocra-anthropic/claude"] },
    });
    render(
      <PrefsProvider>
        <SetDraft to={change} />
      </PrefsProvider>,
    );
    await screen.findByRole("region", { name: "Unsaved changes" });
  });

  it("Discard shows the saved number again after unparsable text", async () => {
    fakeApi();
    render(
      <PrefsProvider>
        <ReviewSettings />
      </PrefsProvider>,
    );
    const tasks = (await screen.findByLabelText("Most review tasks")) as HTMLInputElement;
    await waitFor(() => expect(tasks.value).toBe("20"));
    // Another field makes the draft dirty; "abc" never reaches it.
    fireEvent.change(screen.getByLabelText("Tasks at once"), { target: { value: "4" } });
    fireEvent.change(tasks, { target: { value: "abc" } });
    expect(tasks.value).toBe("abc");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(tasks.value).toBe("20"));
    expect(tasks.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("ARIA", () => {
  it("Seg is a group of pressed toggles, not tabs without panels", () => {
    render(
      <Seg
        label="Range"
        value={7}
        options={[
          { value: 7, label: "1W" },
          { value: 30, label: "1M" },
        ]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    screen.getByRole("group", { name: "Range" });
    expect(screen.getByRole("button", { name: "1W" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "1M" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("the account menu is a disclosure that Escape closes, returning focus", () => {
    render(<TopBar me={{ login: "ada", githubId: 1, session: "web", since: "" }} />);
    const button = screen.getByRole("button", { name: /ada/ });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
    const controls = button.getAttribute("aria-controls");
    expect(controls && document.getElementById(controls)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});

describe("shared types", () => {
  it("web settings are the server's: no github key, which the server refuses", () => {
    // @ts-expect-error github is not a setting the server accepts
    const s: Settings = { github: { requestChanges: true } };
    expect(s).toBeTruthy();
  });
});

describe("file size", () => {
  it("no web source file is over 500 lines", () => {
    const files = import.meta.glob<string>("./**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const long = Object.entries(files)
      .filter(([, src]) => src.split("\n").length > 500)
      .map(([path]) => path);
    expect(long).toEqual([]);
  });
});

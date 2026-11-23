import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetKeys } from "./account-keys.js";
import type { Me } from "./api.js";
import { Footer, TopBar } from "./chrome.js";
import { Keys } from "./pages/Keys.js";
import { Overview } from "./pages/Overview.js";
import { SignIn } from "./signin.js";
import { brandTag } from "./site.js";

// The console's links and copy: the current docs, the real provider count,
// no "coming soon" on what has shipped, and "dev" only off production.

const providers = Array.from({ length: 46 }, (_, i) => ({
  name: `p${i}`,
  label: `Provider ${i}`,
  group: "Major",
  base: `https://p${i}.example.com`,
  paths: ["/v1/chat/completions"],
}));

function fakeApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input);
      if (path.endsWith("/api/providers")) return Response.json({ providers });
      if (path.endsWith("/api/keys")) return Response.json({ keys: [] });
      if (path.endsWith("/api/sessions")) return Response.json({ sessions: [] });
      if (path.includes("/api/reviews")) return Response.json({ summary: { reviews: 0 } });
      if (path.endsWith("/api/auto-review/repos"))
        return Response.json({ error: "not_found" }, { status: 404 });
      if (path.includes("/api/usage"))
        return Response.json({
          days: 14,
          today: 0,
          dailyLimit: 1000,
          series: [],
          models: [],
          calls: [],
        });
      return Response.json({});
    }),
  );
}

afterEach(() => {
  forgetKeys();
  cleanup();
  vi.unstubAllGlobals();
});

const ME: Me = {
  login: "ada",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web",
  since: "",
  codeGraphs: "off",
  autoReview: false,
  platforms: ["github"],
};

describe("links", () => {
  it("every docs link goes to ocracloud.com/docs", async () => {
    render(
      <>
        <TopBar
          me={{
            login: "ada",
            githubId: 1,
            githubUrl: "https://github.com",
            avatarUrl: null,
            session: "web",
            since: "",
            codeGraphs: "off",
            autoReview: false,
            platforms: ["github", "gitlab"],
          }}
        />
        <Footer />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /ada/ }));
    await screen.findByRole("menu");
    const docs = [...document.querySelectorAll("a")]
      .filter((a) => /^Doc/.test(a.textContent ?? ""))
      .map((a) => a.getAttribute("href"));
    expect(docs).toHaveLength(3);
    for (const href of docs) expect(href).toBe("https://ocracloud.com/docs");
    expect(document.body.innerHTML).not.toContain("majincheng");
  });

  it("tags the brand dev everywhere but the production host", () => {
    expect(brandTag("app.ocracloud.com")).toBe("cloud");
    expect(brandTag("ocra-cloud.majincheng990128.workers.dev")).toBe("cloud · dev");
    expect(brandTag("localhost")).toBe("cloud · dev");
  });
});

describe("provider count", () => {
  it("Overview's setup steps count the providers and do not call ocra login coming soon", async () => {
    fakeApi();
    render(<Overview me={ME} />);
    await screen.findByText(/any of 46 providers/);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(document.body.textContent).not.toContain("45");
  });

  it("the sign-in screen counts the providers", async () => {
    fakeApi();
    render(<SignIn />);
    await screen.findByText(/any of 46 providers/);
  });

  it("the key drawer searches the counted providers", async () => {
    fakeApi();
    render(<Keys />);
    await screen.findByText(/any of 46 providers/);
    fireEvent.click(screen.getByRole("button", { name: "Add your first key" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Search providers").getAttribute("placeholder")).toBe(
        "Search 46 providers by name or domain",
      ),
    );
  });
});

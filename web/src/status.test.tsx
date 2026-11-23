import { cleanup, render, screen } from "@testing-library/react";
import History from "lucide-react/icons/history";
import { afterEach, describe, expect, it } from "vitest";
import { Status } from "@/components/status";

afterEach(cleanup);

describe("Status", () => {
  it("says the word in its tone, with a mark a screen reader skips", () => {
    render(<Status tone="err">Conflicts</Status>);
    const status = screen.getByText("Conflicts");
    expect(status.className).toBe("status status-err");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector("svg")?.classList.contains("lucide-circle-x")).toBe(true);
  });

  it("takes another mark when the tone's own does not fit the word", () => {
    render(
      <Status tone="quiet" icon={History}>
        Outdated
      </Status>,
    );
    expect(
      screen.getByText("Outdated").querySelector("svg")?.classList.contains("lucide-history"),
    ).toBe(true);
  });
});

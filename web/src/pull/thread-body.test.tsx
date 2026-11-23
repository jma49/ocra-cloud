import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadBody } from "./thread-body.js";

afterEach(cleanup);

const FINDING = [
  "<!-- ocra:finding e9953cfd0d2ebf46 -->",
  "🟠 **Ambiguous `within()` · twice** · warning · verified · security · low confidence",
  "",
  "In `within()`, the alternatives **overlap**.",
  "",
  "**Suggestion:** Make them exclusive.",
  "",
  "```suggestion",
  "const a = 1;",
  "```",
].join("\n");

describe("a review comment's body", () => {
  it("draws ocra's finding with a head, Markdown below, and neither its marker nor its suggestion block", () => {
    const { container } = render(<ThreadBody body={FINDING} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("ocra:finding");
    expect(text).not.toContain("**");
    expect(text).not.toContain("const a = 1;");
    expect(container.querySelector(".thread-finding-title")?.textContent).toBe(
      "Ambiguous within() · twice",
    );
    expect(container.querySelector(".thread-finding-title code")?.textContent).toBe("within()");
    expect(container.querySelector(".badge")?.textContent).toBe("Warning");
    expect(container.querySelector(".thread-finding-notes .subtle")?.textContent).toBe(
      "verified · security · low confidence",
    );
    expect([...container.querySelectorAll("strong")].map((s) => s.textContent)).toEqual([
      "overlap",
      "Suggestion:",
    ]);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("draws a person's comment as Markdown, with its https links, and no head", () => {
    const { container } = render(
      <ThreadBody
        body={
          "🟠 **Looks like a head** · warning · mine\r\n\r\nSee [the doc](https://example.com/a) and `x`.\n\n```ts\nconst b = 2;\n```"
        }
      />,
    );
    expect(container.querySelector(".thread-finding")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("Looks like a head");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(container.querySelector("pre code")?.textContent).toBe("const b = 2;");
  });

  it("hides an HTML comment left open to the end, and draws nothing for an empty body", () => {
    const { container } = render(<ThreadBody body={"Kept. <!-- hidden\nstill hidden"} />);
    expect(container.textContent).toBe("Kept.");
    cleanup();
    expect(render(<ThreadBody body={"<!-- only -->\n"} />).container.innerHTML).toBe("");
  });

  it("reads a long body of unclosed comments and fences in no time", { timeout: 60_000 }, () => {
    const started = performance.now();
    render(<ThreadBody body={`${"<!-".repeat(20_000)}${"```suggestion\n".repeat(5_000)}`} />);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

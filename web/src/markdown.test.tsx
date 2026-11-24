import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown.js";

afterEach(cleanup);

const html = (text: string) => render(<Markdown text={text} />).container.innerHTML;

describe("Markdown", () => {
  it("draws paragraphs, headings, lists, code and emphasis", () => {
    const { container } = render(
      <Markdown
        text={[
          "## Why",
          "",
          "The check uses `charge.captured`, **not** what is *left*.",
          "",
          "- first",
          "- second",
          "",
          "1. one",
          "2. two",
          "",
          "```ts",
          "if (amount > left) throw new Error();",
          "```",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("h4")?.textContent).toBe("Why");
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector("p code")?.textContent).toBe("charge.captured");
    expect(container.querySelector("strong")?.textContent).toBe("not");
    expect(container.querySelector("em")?.textContent).toBe("left");
    expect([...container.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual([
      "first",
      "second",
    ]);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe(
      "if (amount > left) throw new Error();",
    );
  });

  it("keeps links, images and HTML as the text they were written as", () => {
    const { container } = render(
      <Markdown
        text={
          'See [the fix](https://evil.example/?q=secret) ![x](https://evil.example/p.png) <img src=x onerror="alert(1)"> <a href="https://evil.example">here</a>'
        }
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[the fix](https://evil.example/?q=secret)");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("runs emphasis around a link or code that has the mark in it", () => {
    const { container } = render(
      <Markdown
        text={
          "_By **Ada** in [the thread](https://example.com/t?id=a_b_c) and `snake_case`_ then a_b"
        }
      />,
    );
    const em = container.querySelector("em");
    expect(em?.textContent).toBe(
      "By Ada in [the thread](https://example.com/t?id=a_b_c) and snake_case",
    );
    expect(em?.querySelector("strong")?.textContent).toBe("Ada");
    expect(em?.querySelector("code")?.textContent).toBe("snake_case");
    expect(container.textContent).toContain(" then a_b");
  });

  // 22 spans: enough for a pattern that doubles its work per span to take seconds.
  it("reads emphasis that never closes in no time, whatever it holds", { timeout: 60_000 }, () => {
    const started = performance.now();
    for (const part of ["`a` ", "`` `a` `` ", "`` a ", "[a](b) ", "[ ` ", "_a "]) {
      const text = `_${part.repeat(22)}`;
      const { container } = render(<Markdown text={`${text}\n\n*${part.repeat(22)}`} />);
      expect(container.querySelector("em")).toBeNull();
      cleanup();
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads a code span fenced by two backticks, and no emphasis out of the marks around it", () => {
    const { container } = render(
      <Markdown text={"Input is `_` then `` `a` `` with no closing `_`; `*` too. Used ``a`b``."} />,
    );
    expect(container.querySelector("em")).toBeNull();
    const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toEqual(["_", "`a`", "_", "*", "a`b"]);
  });

  it("keeps a stray backtick or bracket inside emphasis as written", () => {
    const { container } = render(<Markdown text={"_a ` b [c] d_"} />);
    expect(container.querySelector("em")?.textContent).toBe("a ` b [c] d");
  });

  it("draws a table, and a heading at the level it was written", () => {
    const { container } = render(
      <Markdown
        text={[
          "# What",
          "",
          "| Case | After |",
          "| --- | :-: |",
          "| `a` | refused |",
          "| b |",
          "",
          "### Deep",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("h3")?.textContent).toBe("What");
    expect(container.querySelector("h5")?.textContent).toBe("Deep");
    expect([...container.querySelectorAll("th")].map((c) => c.textContent)).toEqual([
      "Case",
      "After",
    ]);
    expect([...container.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual([
      "arefused",
      "b",
    ]);
    expect(container.querySelector("td code")?.textContent).toBe("a");
  });

  it("shows a code block whose fence has not closed yet, and leaves snake_case and 2 * 3 * 4 alone", () => {
    expect(html("```\nconst a = 1;")).toContain("<pre><code>const a = 1;</code></pre>");
    const text = render(<Markdown text="refund_partial_amount and 2 * 3 * 4" />).container;
    expect(text.querySelector("em")).toBeNull();
  });
});

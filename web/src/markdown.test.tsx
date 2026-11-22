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

  it("shows a code block whose fence has not closed yet, and leaves snake_case and 2 * 3 * 4 alone", () => {
    expect(html("```\nconst a = 1;")).toContain("<pre><code>const a = 1;</code></pre>");
    const text = render(<Markdown text="refund_partial_amount and 2 * 3 * 4" />).container;
    expect(text.querySelector("em")).toBeNull();
  });
});

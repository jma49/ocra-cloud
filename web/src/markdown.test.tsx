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

  it("opens a person's https links when asked, and nothing else", () => {
    const { container } = render(
      <Markdown
        links
        text={
          '_See_ [the **note**](https://example.com/a?b=1) [x](javascript:alert(1)) [y](http://example.com/) ![z](https://example.com/p.png) <a href="https://evil.example">here</a>'
        }
      />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.textContent, a.target, a.rel])).toEqual([
      ["https://example.com/a?b=1", "the note", "_blank", "noopener noreferrer nofollow"],
    ]);
    expect(container.querySelector("a strong")?.textContent).toBe("note");
    expect(container.querySelector("em")?.textContent).toBe("See");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[x](javascript:alert(1))");
    expect(container.textContent).toContain("[y](http://example.com/)");
    expect(container.textContent).toContain("![z](https://example.com/p.png)");
  });

  it("runs emphasis around a link or code that has the mark in it", () => {
    const { container } = render(
      <Markdown
        links
        text={
          "_By **Ada** in [the thread](https://example.com/t?id=a_b_c) and `snake_case`_ then a_b"
        }
      />,
    );
    const em = container.querySelector("em");
    expect(em?.textContent).toBe("By Ada in the thread and snake_case");
    expect(em?.querySelector("strong")?.textContent).toBe("Ada");
    expect(em?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/t?id=a_b_c");
    expect(em?.querySelector("code")?.textContent).toBe("snake_case");
    expect(container.textContent).toContain(" then a_b");
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

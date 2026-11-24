import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformMarkdown, platformHtml } from "./platform-markdown.js";

afterEach(cleanup);

const dom = (text: string) => render(<PlatformMarkdown text={text} />).container;

describe("text a person wrote on the platform", () => {
  it("folds a details block under its summary, as the platform does", () => {
    const md = dom(
      "Bumps x.\n\n<details>\n<summary>Release notes</summary>\n\n- **1.2.0** fixes y\n</details>\n\n<!-- hidden -->",
    );
    const details = md.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("Release notes");
    expect(details?.querySelector("summary > .fold")).not.toBeNull();
    expect(details?.querySelector("li strong")?.textContent).toBe("1.2.0");
    expect(md.textContent).not.toContain("<details>");
    expect(md.innerHTML).not.toContain("<!--");
  });

  it("opens https links in a new tab and keeps no other address", () => {
    const md = dom(
      '[ok](https://example.com/a) [bad](javascript:alert(1)) <a href="http://x.test" onclick="steal()">plain</a>',
    );
    const links = [...md.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["ok", "https://example.com/a"],
    ]);
    expect(md.textContent).toContain("bad plain");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(md.innerHTML).not.toMatch(/onclick|javascript:/);
  });

  it("takes out scripts, styles, frames and forms", () => {
    const html = platformHtml(
      '<script>alert(1)</script><style>*{}</style><iframe src="https://x.test"></iframe><form><button>go</button></form><img src=x onerror=alert(1)>ok',
    );
    expect(html).not.toMatch(/script|style|iframe|form|button|onerror/);
    expect(html).toContain("ok");
  });

  it("links to a picture rather than loading it", () => {
    const md = dom("![Dependabot compatibility score](https://badges.example/score.svg)");
    expect(md.querySelector("img")).toBeNull();
    const a = md.querySelector("a");
    expect([a?.textContent, a?.getAttribute("href")]).toEqual([
      "Dependabot compatibility score",
      "https://badges.example/score.svg",
    ]);
  });

  it("draws tables, task lists and line breaks, with headings under the page's own", () => {
    const md = dom(
      "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] not yet\n\none\ntwo",
    );
    expect(md.querySelector("h3")?.textContent).toBe("Title");
    expect(md.querySelectorAll("td")).toHaveLength(2);
    const boxes = [...md.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(md.querySelector("p:last-child br")).not.toBeNull();
  });
});

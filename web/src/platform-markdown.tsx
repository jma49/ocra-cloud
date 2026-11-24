import { Marked } from "marked";

// Text a person wrote on the code platform (a pull request's description, a
// review comment), drawn as the platform draws it: GitHub-flavored Markdown
// with the HTML it allows (details, tables, sub and sup, kbd, line breaks).
// Everything else is taken out, links open only https in a new tab, and a
// picture becomes a link to it: the console's Content-Security-Policy loads
// no picture from another host, and showing one would tell that host who reads.

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // A document's headings start under the page's own: `#` is an h3.
    heading({ tokens, depth }) {
      const h = `h${Math.min(depth + 2, 6)}`;
      return `<${h}>${this.parser.parseInline(tokens)}</${h}>\n`;
    },
  },
});

const TAGS = (
  "a b blockquote br code dd del details div dl dt em h3 h4 h5 h6 hr i img input ins kbd li " +
  "mark ol p pre q s samp span strike strong sub summary sup table tbody td tfoot th thead " +
  "tr tt ul var"
).split(" ");
const ATTRS = "alt checked colspan disabled href open rowspan src title type".split(" ");
/** Elements outside the list whose content goes with them; any other one leaves its content. */
const DROPPED = new Set(
  "script style iframe frame object embed template noscript textarea select option title svg math form button head".split(
    " ",
  ),
);

/** The address a link opens: https only, as `URL` reads it, never what was written. */
function httpsAddress(written: string | null): string | null {
  if (!written || !URL.canParse(written)) return null;
  const url = new URL(written);
  return url.protocol === "https:" ? url.href : null;
}

function opensOutside(a: Element, href: string) {
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer nofollow");
}

/** Keeps only the listed elements and attributes, and no comments. */
function allowOnly(node: Node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) child.remove();
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      allowOnly(el);
      const tag = el.tagName.toLowerCase();
      if (!TAGS.includes(tag)) {
        if (DROPPED.has(tag)) el.remove();
        else el.replaceWith(...el.childNodes);
        continue;
      }
      for (const { name } of [...el.attributes])
        if (!ATTRS.includes(name.toLowerCase())) el.removeAttribute(name);
    }
  }
}

/** What is left after the allowlist, made to behave as the console does. */
function settle(root: DocumentFragment) {
  allowOnly(root);
  const doc = root.ownerDocument;
  for (const a of root.querySelectorAll("a")) {
    const href = httpsAddress(a.getAttribute("href"));
    if (href === null) a.replaceWith(...a.childNodes);
    else opensOutside(a, href);
  }
  for (const img of root.querySelectorAll("img")) {
    const src = httpsAddress(img.getAttribute("src"));
    const alt = img.getAttribute("alt")?.trim();
    if (src === null && !alt) {
      img.remove();
      continue;
    }
    const linked = src !== null && !img.closest("a");
    const stand = doc.createElement(linked ? "a" : "span");
    stand.textContent = alt || "Image";
    if (linked) opensOutside(stand, src);
    img.replaceWith(stand);
  }
  // Only a task list's box stays, and it cannot be ticked here.
  for (const input of root.querySelectorAll("input")) {
    if (input.getAttribute("type") === "checkbox") input.setAttribute("disabled", "");
    else input.remove();
  }
  for (const summary of root.querySelectorAll("summary")) {
    const fold = doc.createElement("span");
    fold.className = "fold";
    fold.setAttribute("aria-hidden", "true");
    summary.prepend(fold);
  }
}

/**
 * The text as safe HTML: what the platform's own page would show of it.
 * It is parsed into a template, whose content runs nothing and loads nothing,
 * and only what the lists allow leaves it. Nothing from another namespace or
 * with raw text (svg, math, style, textarea) is allowed, so what is written
 * out reads back as the same tree.
 */
export function platformHtml(text: string): string {
  const box = document.createElement("template");
  box.innerHTML = marked.parse(text) as string;
  settle(box.content);
  return box.innerHTML;
}

export function PlatformMarkdown(props: { text: string }) {
  return (
    <div
      className="md md-html"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: platformHtml keeps only an allowlist of tags and attributes and https links
      dangerouslySetInnerHTML={{ __html: platformHtml(props.text) }}
    />
  );
}

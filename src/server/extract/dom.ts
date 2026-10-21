import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type $ = cheerio.CheerioAPI;
export type Sel = cheerio.Cheerio<AnyNode>;

const NOISE = "script, style, noscript, template, svg, iframe, link, meta";
const BLOCK = /^(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|br|hr|main|aside|nav|dd|dt|blockquote|pre|figure|figcaption|form)$/i;

export function load(html: string) {
  return cheerio.load(html);
}

export function clean(text: string) {
  return text.replace(/[​‎‏]/g, "").replace(/[ \t ]+/g, " ").trim();
}

/** Readable text with line breaks at block elements, for diffs and for the AI. */
export function readableText($: $, root?: Sel): string {
  const scope = (root ?? $("body").first()).clone();
  scope.find(NOISE).remove();
  const lines: string[] = [];
  let buf = "";
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type === "text") buf += (n as unknown as { data: string }).data;
      else if (n.type === "tag") {
        const el = n as Element;
        const isBlock = BLOCK.test(el.tagName);
        if (isBlock && buf.trim()) { lines.push(clean(buf)); buf = ""; }
        walk(el.children);
        if (isBlock && buf.trim()) { lines.push(clean(buf)); buf = ""; }
        else if (el.tagName === "td" || el.tagName === "th") buf += " | ";
      }
    }
  };
  walk(scope.toArray());
  if (buf.trim()) lines.push(clean(buf));
  return lines.filter(Boolean).filter((l, i, a) => l !== a[i - 1]).join("\n");
}

export function absolutize(value: string | undefined, base: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || v.startsWith("javascript:") || v.startsWith("data:")) return null;
  try {
    return new URL(v, base).toString();
  } catch {
    return null;
  }
}

/** Reads text, inner HTML or an attribute; URL-like attributes become absolute. */
export function readValue($: $, el: Sel, attr: string, base: string): string | null {
  if (!el.length) return null;
  if (attr === "text") return clean(el.text()) || null;
  if (attr === "html") return el.html()?.trim() || null;
  const raw = el.attr(attr) ?? (attr === "src" ? el.attr("data-src") ?? el.attr("data-lazy-src") : undefined);
  if (raw === undefined) return null;
  return ["href", "src", "data-src", "action", "poster"].includes(attr) ? absolutize(raw, base) : clean(raw);
}

/** Validates a CSS selector before using it, so a typo gives a clear message instead of a crash. */
export function safeSelect($: $, selector: string, root?: Sel): Sel {
  try {
    return root ? root.find(selector) : $(selector);
  } catch {
    throw new Error(`"${selector}" is not a valid CSS selector.`);
  }
}

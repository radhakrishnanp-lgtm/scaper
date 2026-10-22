import "server-only";
import type { AnyNode, Element } from "domhandler";
import { absolutize, clean, load, type $ } from "../extract/dom";

/**
 * Turns a web page into the context a language model reads best: Markdown with headings, lists and
 * tables, links written as numbered references ([text][12]) so the model can name a link without
 * copying long URLs, plus the page's structured data. Sized to a token budget.
 */

export type LinkArea = "nav" | "header" | "main" | "aside" | "footer";
export type LinkRef = { i: number; text: string; href: string; area: LinkArea; image?: boolean };
export type PageContext = {
  url: string; title: string; description: string; lang: string;
  markdown: string; links: LinkRef[]; structured: string; tokens: number; truncated: boolean;
};

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "head", "meta", "link", "select", "option", "button", "input", "textarea", "dialog"]);
const BLOCK = new Set(["html", "body", "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "figure", "figcaption", "address", "fieldset", "details", "summary", "dl", "dt", "dd", "center"]);
const CHROME = "header, nav, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [aria-modal=true], [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]";
const ASSET = /\.(?:jpe?g|png|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|zip|mp4|mp3)(?:\?|#|$)/i;

function hidden(el: Element) {
  const a = el.attribs;
  return a.hidden !== undefined || a["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? "");
}

function areaOf(el: Element): LinkArea {
  for (let p: Element | null = el; p; p = p.parent && p.parent.type === "tag" ? (p.parent as Element) : null) {
    const t = p.tagName;
    const role = p.attribs.role;
    if (t === "nav" || role === "navigation") return "nav";
    if (t === "footer" || role === "contentinfo") return "footer";
    if (t === "header" || role === "banner") return "header";
    if (t === "aside" || role === "complementary") return "aside";
    if (t === "main" || role === "main") return "main";
  }
  return "main";
}

type Builder = { links: LinkRef[]; byHref: Map<string, number>; base: string; maxLinks: number };

function linkRef(b: Builder, href: string, text: string, area: LinkArea, image = false): number | null {
  const existing = b.byHref.get(href);
  if (existing !== undefined) {
    const l = b.links[existing - 1]!;
    if (!l.text && text) l.text = text;
    return existing;
  }
  if (b.links.length >= b.maxLinks) return null;
  const i = b.links.length + 1;
  b.links.push({ i, text: text.slice(0, 120), href, area, image: image || undefined });
  b.byHref.set(href, i);
  return i;
}

function inlineText(b: Builder, nodes: AnyNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") { out += (n as unknown as { data: string }).data; continue; }
    if (n.type !== "tag") continue;
    const el = n as Element;
    if (SKIP.has(el.tagName) || hidden(el)) continue;
    if (el.tagName === "br") { out += " "; continue; }
    if (el.tagName === "img") { out += imageMd(b, el); continue; }
    if (el.tagName === "a") { out += anchorMd(b, el); continue; }
    out += inlineText(b, el.children);
  }
  return out;
}

function anchorMd(b: Builder, el: Element) {
  const text = clean(inlineTextPlain(el.children)) || clean(el.attribs["aria-label"] ?? el.attribs.title ?? "");
  const inner = clean(inlineText(b, el.children.filter((c) => !(c.type === "tag" && (c as Element).tagName === "a"))));
  const href = absolutize(el.attribs.href, b.base);
  if (!href || !/^https?:/i.test(href) || href.split("#")[0] === b.base.split("#")[0] && el.attribs.href?.startsWith("#")) return inner || text;
  const i = linkRef(b, href, text, areaOf(el), ASSET.test(href));
  const label = inner || text || "link";
  return i ? ` [${label}][${i}] ` : ` ${label} `;
}

function imageMd(b: Builder, el: Element) {
  const src = absolutize(el.attribs.src && !el.attribs.src.startsWith("data:") ? el.attribs.src : el.attribs["data-src"] ?? el.attribs["data-lazy-src"] ?? el.attribs.src, b.base);
  const alt = clean(el.attribs.alt ?? "");
  if (!src || !/^https?:/i.test(src)) return alt ? ` ${alt} ` : "";
  const i = linkRef(b, src, alt, areaOf(el), true);
  return i ? ` ![${alt.slice(0, 80)}][${i}] ` : alt ? ` ${alt} ` : "";
}

function inlineTextPlain(nodes: AnyNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += (n as unknown as { data: string }).data;
    else if (n.type === "tag" && !SKIP.has((n as Element).tagName)) out += " " + inlineTextPlain((n as Element).children) + " ";
  }
  return out;
}

function tableMd(b: Builder, table: Element): string {
  const rows: string[][] = [];
  const walkRows = (el: Element) => {
    for (const c of el.children) {
      if (c.type !== "tag") continue;
      const t = (c as Element).tagName;
      if (t === "tr") {
        const cells = (c as Element).children.filter((x): x is Element => x.type === "tag" && (x.tagName === "td" || x.tagName === "th"));
        rows.push(cells.slice(0, 20).map((cell) => clean(inlineText(b, cell.children)).replace(/\|/g, "/").slice(0, 200)));
      } else if (t === "thead" || t === "tbody" || t === "tfoot") walkRows(c as Element);
      if (rows.length >= 200) return;
    }
  };
  walkRows(table);
  const useful = rows.filter((r) => r.some(Boolean));
  if (!useful.length) return "";
  const width = Math.max(...useful.map((r) => r.length));
  if (width === 1) return useful.map((r) => r[0]).join("\n");
  const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
  return [pad(useful[0]!), `|${" --- |".repeat(width)}`, ...useful.slice(1).map(pad)].join("\n");
}

function blocksMd(b: Builder, nodes: AnyNode[], out: string[], depth = 0, listDepth = 0) {
  let buf = "";
  const flush = () => { const t = clean(buf); if (t) out.push(t); buf = ""; };
  for (const n of nodes) {
    if (n.type === "text") { buf += (n as unknown as { data: string }).data; continue; }
    if (n.type !== "tag") continue;
    const el = n as Element;
    const tag = el.tagName;
    if (SKIP.has(tag) || hidden(el)) continue;
    if (/^h[1-6]$/.test(tag)) { flush(); const t = clean(inlineText(b, el.children)); if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t}`); continue; }
    if (tag === "ul" || tag === "ol") {
      flush();
      let k = 0;
      for (const li of el.children) {
        if (li.type !== "tag" || (li as Element).tagName !== "li") continue;
        k++;
        const inner: string[] = [];
        blocksMd(b, (li as Element).children, inner, depth + 1, listDepth + 1);
        const indent = "  ".repeat(listDepth);
        const bullet = tag === "ol" ? `${k}.` : "-";
        if (inner.length) out.push(`${indent}${bullet} ${inner[0]!.trimStart()}`, ...inner.slice(1));
      }
      continue;
    }
    if (tag === "table") { flush(); const t = tableMd(b, el); if (t) out.push(t); continue; }
    if (tag === "pre") { flush(); const t = inlineTextPlain(el.children).trim(); if (t) out.push("```\n" + t.slice(0, 4000) + "\n```"); continue; }
    if (tag === "blockquote") { flush(); const inner: string[] = []; blocksMd(b, el.children, inner, depth + 1, listDepth); out.push(...inner.map((l) => `> ${l}`)); continue; }
    if (tag === "hr") { flush(); out.push("---"); continue; }
    if (tag === "br") { flush(); continue; }
    if (tag === "img") { buf += imageMd(b, el); continue; }
    if (tag === "a") {
      // A link that wraps blocks (a whole product card) is read as blocks, then the link is added.
      const hasBlocks = el.children.some((c) => c.type === "tag" && (BLOCK.has((c as Element).tagName) || /^h[1-6]$/.test((c as Element).tagName)));
      if (hasBlocks) {
        flush();
        const inner: string[] = [];
        blocksMd(b, el.children, inner, depth + 1, listDepth);
        const href = absolutize(el.attribs.href, b.base);
        const i = href && /^https?:/i.test(href) ? linkRef(b, href, clean(inlineTextPlain(el.children)).slice(0, 120), areaOf(el)) : null;
        out.push(...inner);
        if (i) out.push(`[open][${i}]`);
      } else buf += anchorMd(b, el);
      continue;
    }
    if (BLOCK.has(tag) || tag === "li" || tag === "tr") { flush(); blocksMd(b, el.children, out, depth + 1, listDepth); continue; }
    buf += inlineText(b, [el]);
  }
  flush();
}

function structuredData($: $): string {
  const out: string[] = [];
  let size = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (size > 4000) return;
    try {
      const data = JSON.parse($(el).text()) as unknown;
      const s = JSON.stringify(data, (k, v) => (k === "@context" || k === "potentialAction" ? undefined : typeof v === "string" ? v.slice(0, 300) : v));
      if (s && s.length > 2) { out.push(s.slice(0, 4000 - size)); size += s.length; }
    } catch { /* broken JSON-LD is common; skip it */ }
  });
  return out.join("\n");
}

export type ContextOptions = {
  /** Token budget for the Markdown; the link list and structured data are budgeted separately. */
  budgetTokens?: number;
  /** "main": drop headers, menus, footers and cookie banners. "full": everything. */
  scope?: "main" | "full";
  maxLinks?: number;
};

export function buildPageContext(html: string, url: string, opts: ContextOptions = {}): PageContext {
  const $ = load(html);
  const title = clean($("title").first().text()).slice(0, 300);
  const description = clean($('meta[name="description"], meta[property="og:description"]').first().attr("content") ?? "").slice(0, 400);
  const lang = ($("html").attr("lang") ?? "").slice(0, 10);
  const structured = structuredData($);
  const b: Builder = { links: [], byHref: new Map(), base: url, maxLinks: opts.maxLinks ?? 1500 };

  const body = $("body").first();
  let root = body;
  if (opts.scope !== "full") {
    const main = $("main, [role=main]").first();
    const candidate = (main.length ? main : body).clone();
    candidate.find(CHROME).remove();
    // Some sites put everything inside <header> or <nav>; fall back to the full page when little is left.
    const kept = clean(candidate.text()).length;
    if (kept > 200 || kept >= clean(body.text()).length * 0.4) root = candidate;
  }
  const out: string[] = [];
  blocksMd(b, root.toArray(), out);
  const lines = out.filter((l, i) => l !== out[i - 1]);
  let markdown = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ");

  let truncated = false;
  if (opts.budgetTokens && estimateTokens(markdown) > opts.budgetTokens) {
    markdown = markdown.slice(0, Math.floor(opts.budgetTokens * 3.6));
    markdown = markdown.slice(0, Math.max(markdown.lastIndexOf("\n"), markdown.length - 200)) + "\n[… page continues, cut to fit the model]";
    truncated = true;
  }
  return { url, title, description, lang, markdown, links: b.links, structured, tokens: estimateTokens(markdown), truncated };
}

/** Navigation links (menus, header, footer) gathered separately: they never make it into "main" Markdown but are what category discovery needs. */
export function collectLinks(html: string, url: string, max = 600): LinkRef[] {
  const $ = load(html);
  const b: Builder = { links: [], byHref: new Map(), base: url, maxLinks: max };
  $("a[href]").each((_, el) => {
    const e = el as Element;
    if (hidden(e)) return;
    const href = absolutize(e.attribs.href, url);
    if (!href || !/^https?:/i.test(href) || ASSET.test(href)) return;
    const text = clean(inlineTextPlain(e.children)) || clean(e.attribs["aria-label"] ?? e.attribs.title ?? "");
    linkRef(b, href.split("#")[0]!, text, areaOf(e));
  });
  return b.links;
}

/** Splits Markdown into parts of about `tokens` each, cutting at line breaks, each part repeating the end of the one before. */
export function chunkMarkdown(markdown: string, tokens: number, overlap = 0.08): string[] {
  const size = Math.max(500, Math.floor(tokens * 3.6));
  if (markdown.length <= size) return [markdown];
  const parts: string[] = [];
  let start = 0;
  while (start < markdown.length) {
    let end = Math.min(markdown.length, start + size);
    if (end < markdown.length) {
      const cut = markdown.lastIndexOf("\n", end);
      if (cut > start + size * 0.5) end = cut;
    }
    parts.push(markdown.slice(start, end));
    if (end >= markdown.length) break;
    start = Math.max(end - Math.floor(size * overlap), start + 1);
  }
  return parts;
}

/** The link list as the model sees it: one line per link, paths relative to the page's site to save tokens. */
export function linkLines(links: LinkRef[], pageUrl: string, max = 400) {
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch { /* keep absolute */ }
  return links.slice(0, max).map((l) => `[${l.i}] ${l.area} | ${l.text || "(no text)"} | ${origin && l.href.startsWith(origin) ? l.href.slice(origin.length) || "/" : l.href}`).join("\n");
}

/** Text for exact-match checks: lower case, links and punctuation removed, spaces collapsed. */
export function normalizeForMatch(s: string) {
  return s.toLowerCase().replace(/!?\[([^\]]*)\]\[\d+\]/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

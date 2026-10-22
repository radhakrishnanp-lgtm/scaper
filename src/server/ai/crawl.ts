import "server-only";
import type { Element } from "domhandler";
import { z } from "zod";
import type { FetchMode, Pagination } from "@/lib/schemas";
import type { Cell } from "@/lib/types";
import { absolutize, clean, load, type $ } from "../extract/dom";
import { fetchPage } from "../fetcher";
import { chat, parseJsonReply, AiError, type ModelChoice } from "./client";
import { collectLinks, linkLines, type LinkRef } from "./context";
import { UNTRUSTED_NOTE } from "./extract";
import { suggestSelectors } from "./suggest";

/**
 * Category scrape planner. Your model reads the start page's links and picks the category pages that hold
 * what you asked for; Scaper then works out item selectors on one category (tested on the page) and finds
 * the "next page" link. The plan becomes an ordinary task: same polite fetcher, history, exports and schedules.
 */

export type CrawlPlan = {
  startUrl: string;
  title: string;
  goal: string;
  mode: FetchMode;
  categories: { name: string; url: string; picked: boolean }[];
  sample: { url: string; itemSelector: string; fields: { name: string; selector: string; attr: string }[]; rows: Record<string, Cell>[]; count: number; note: string | null };
  pagination: Pagination;
  /** Other menu links from the start page, to add categories the AI skipped. */
  otherLinks: { name: string; url: string }[];
  notes: string[];
};

const SKIP_PATH = /\/(log-?in|sign-?in|sign-?up|register|account|my-?account|cart|basket|checkout|wishlist|help|support|contact|privacy|terms|legal|cookies?|careers?|jobs|press|about|faq|returns?|shipping|policy|policies|track-?order)(\/|$|\?)/i;

const sameSite = (a: string, b: string) => {
  try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; }
};

/** Same-site links worth showing the model: menus first, no account/cart/policy pages, no duplicates. */
export function candidateLinks(html: string, pageUrl: string, max = 350): LinkRef[] {
  const links = collectLinks(html, pageUrl, 2000).filter((l) => sameSite(l.href, pageUrl) && !SKIP_PATH.test(new URL(l.href).pathname) && l.href.replace(/\/$/, "") !== pageUrl.replace(/\/$/, ""));
  const rank: Record<LinkRef["area"], number> = { nav: 0, header: 1, main: 2, aside: 3, footer: 4 };
  const picked = links.filter((l) => l.text).sort((a, b) => rank[a.area] - rank[b.area] || a.i - b.i).slice(0, max);
  return picked.map((l, k) => ({ ...l, i: k + 1 }));
}

/** A CSS selector that finds this element first, built from its id or classes (no positions, which break across pages). */
function selectorFor($: $, el: Element): string | null {
  const tag = el.tagName;
  const ok = (sel: string) => { try { return $(sel).first()[0] === el ? sel : null; } catch { return null; } };
  if (el.attribs.rel && /\bnext\b/i.test(el.attribs.rel)) { const s = ok(`${tag}[rel~="next"]`); if (s) return s; }
  if (el.attribs["aria-label"]) { const s = ok(`${tag}[aria-label="${el.attribs["aria-label"].replace(/"/g, '\\"')}"]`); if (s) return s; }
  if (el.attribs.id && /^[A-Za-z][\w-]*$/.test(el.attribs.id)) { const s = ok(`#${el.attribs.id}`); if (s) return s; }
  const classes = (el.attribs.class ?? "").split(/\s+/).filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !/\d{2,}/.test(c)).slice(0, 3);
  if (classes.length) { const s = ok(`${tag}.${classes.join(".")}`); if (s) return s; }
  const parent = el.parent && el.parent.type === "tag" ? (el.parent as Element) : null;
  const pClasses = (parent?.attribs.class ?? "").split(/\s+/).filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !/\d{2,}/.test(c)).slice(0, 2);
  if (parent && pClasses.length) { const s = ok(`${parent.tagName}.${pClasses.join(".")} > ${tag}`); if (s) return s; }
  return null;
}

const NEXT_TEXT = /^(next|next page|next ›|next »|next >|›|»|>|→|older posts|older|more results|load next page)$/i;

/** Finds the "next page" link of a listing and returns a pagination rule for it, or none. */
export function detectPagination(html: string, pageUrl: string, maxPages: number): { pagination: Pagination; note: string | null } {
  const $ = load(html);
  const anchors = $("a[href]").toArray() as Element[];
  const score = (a: Element) => {
    const text = clean($(a).text());
    const label = a.attribs["aria-label"] ?? a.attribs.title ?? "";
    const cls = `${a.attribs.class ?? ""} ${(a.parent as Element | null)?.attribs?.class ?? ""}`;
    if (/\bnext\b/i.test(a.attribs.rel ?? "")) return 3;
    if (/^next/i.test(label) || NEXT_TEXT.test(text)) return 2;
    if (/(^|[\s_-])next([\s_-]|$)/i.test(cls)) return 1;
    return 0;
  };
  const ranked = anchors.map((a) => ({ a, s: score(a) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  for (const { a } of ranked) {
    const href = absolutize(a.attribs.href, pageUrl);
    if (!href || href.split("#")[0] === pageUrl.split("#")[0] || !sameSite(href, pageUrl)) continue;
    const selector = selectorFor($, a);
    if (selector) return { pagination: { type: "next", selector, maxPages }, note: `Found the "next page" link (${selector}).` };
  }
  return { pagination: { type: "none" }, note: null };
}

const planReplySchema = z.object({
  start_is_listing: z.boolean().catch(false),
  categories: z.array(z.object({ link: z.coerce.number().int(), name: z.string().trim().max(120).catch("") })).max(200).catch([]),
  note: z.string().max(500).catch(""),
});

export type PlanInput = { url: string; goal: string; mode: FetchMode; maxCategories: number; pagesPerCategory: number; model: ModelChoice; signal?: AbortSignal };

export async function planCategoryScrape(input: PlanInput): Promise<CrawlPlan> {
  const notes: string[] = [];
  const start = await fetchPage(input.url, input.mode, { signal: input.signal });
  const links = candidateLinks(start.html, start.finalUrl);
  let picks: { name: string; url: string }[] = [];
  let startIsListing = false;

  if (links.length) {
    const res = await chat([
      {
        role: "system",
        content: `You plan a scrape of one website. From the numbered links of its start page, pick the category or listing pages that lead to what the user wants. Reply with JSON only: {"start_is_listing": true|false, "categories": [{"link": <number>, "name": "<short category name>"}], "note": "<one sentence>"}. Pick at most ${input.maxCategories}, best first. A good pick lists many items (a category, department, collection, tag or search-results page); never a single item, login, cart, help or policy page. If the user named categories, pick only those. Set start_is_listing to true when the start page itself already lists the items. ${UNTRUSTED_NOTE}`,
      },
      { role: "user", content: `The user wants: ${input.goal}\nStart page: ${start.finalUrl} (${start.title})\nLinks ([number] area | text | path):\n<page>\n${linkLines(links, start.finalUrl, 350)}\n</page>` },
    ], { model: input.model, json: true, temperature: 0, purpose: "plan", signal: input.signal });
    let reply;
    try { reply = planReplySchema.parse(parseJsonReply(res.content)); } catch { throw new AiError("bad_output", "The AI's plan was not readable. Try again, describe what you want more precisely, or use a stronger model."); }
    startIsListing = reply.start_is_listing;
    const seen = new Set<string>();
    for (const c of reply.categories) {
      const l = links[c.link - 1];
      if (!l || seen.has(l.href)) continue;
      seen.add(l.href);
      picks.push({ name: (c.name || l.text).slice(0, 120), url: l.href });
      if (picks.length >= input.maxCategories) break;
    }
    if (reply.note) notes.push(`AI: ${reply.note}`);
  } else {
    notes.push("The start page has no links to other pages of this site, so Scaper reads the start page itself.");
    startIsListing = true;
  }
  if (!picks.length) {
    if (!startIsListing) notes.push("Your AI did not find category pages for this; Scaper will read the start page. Add category links yourself below if you know them.");
    picks = [{ name: start.title.slice(0, 60) || "Start page", url: start.finalUrl }];
  }

  // Work out the item layout on the first category; sites use one template for all of them.
  const first = picks[0]!;
  const samplePage = first.url === start.finalUrl ? start : await fetchPage(first.url, input.mode, { signal: input.signal, scroll: input.mode === "browser" });
  const describe = `${input.goal}. One item per row; include each item's link.`;
  let sample: CrawlPlan["sample"] = { url: samplePage.finalUrl, itemSelector: "", fields: [], rows: [], count: 0, note: null };
  try {
    const s = await suggestSelectors(samplePage.html, samplePage.finalUrl, describe, input.model);
    sample = { url: samplePage.finalUrl, itemSelector: s.itemSelector, fields: s.fields, rows: s.rows, count: s.count, note: s.note };
  } catch (e) {
    sample.note = (e as Error).message;
  }
  if (!sample.count) notes.push("No selectors matched the items on the first category, so the run will let your AI read each page (slower, uses more tokens).");
  const pg = detectPagination(samplePage.html, samplePage.finalUrl, input.pagesPerCategory);
  if (pg.note) notes.push(pg.note);
  else if (input.pagesPerCategory > 1) notes.push("No \"next page\" link was found, so only the first page of each category is read. Add a selector under Pages if the site has one.");

  return {
    startUrl: start.finalUrl,
    title: start.title,
    goal: input.goal,
    mode: input.mode,
    categories: picks.map((p) => ({ ...p, picked: true })),
    sample,
    pagination: input.pagesPerCategory > 1 ? pg.pagination : { type: "none" },
    otherLinks: moreCategoryLinks(start.html, start.finalUrl, picks.map((p) => p.url)),
    notes,
  };
}

/** Other category-looking links from the start page, so you can add ones the AI skipped. */
export function moreCategoryLinks(html: string, pageUrl: string, exclude: string[], max = 60) {
  const skip = new Set(exclude);
  return candidateLinks(html, pageUrl, 400).filter((l) => !skip.has(l.href) && (l.area === "nav" || l.area === "header" || l.area === "main")).slice(0, max).map((l) => ({ name: l.text.slice(0, 80), url: l.href }));
}

import type { Element } from "domhandler";
import type { Cell, Dataset } from "@/lib/types";
import { absolutize, clean, load, readableText, type $, type Sel } from "./dom";
import { PRICE_PATTERN, parsePrice } from "./price";

const MAX_ROWS = 500;

export type RepeatedGroup = {
  itemSelector: string;
  count: number;
  fields: { name: string; selector: string; attr: string }[];
  sample: Record<string, Cell>[];
};

/** Collects schema.org JSON-LD objects (Product, Offer, Article ...), flattening @graph. */
export function jsonLd($: $): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
        else out.push(item);
      }
    } catch {
      /* invalid JSON-LD is common; skip it */
    }
  });
  return out;
}

const typeIs = (o: Record<string, unknown>, t: string) =>
  ([] as unknown[]).concat(o["@type"] ?? []).some((x) => String(x).toLowerCase() === t.toLowerCase());

export function productsFromJsonLd(items: Record<string, unknown>[], base: string): Record<string, Cell>[] {
  const products: Record<string, Cell>[] = [];
  const visit = (o: Record<string, unknown>) => {
    if (typeIs(o, "ItemList") && Array.isArray(o.itemListElement)) {
      for (const el of o.itemListElement as Record<string, unknown>[]) visit((el.item as Record<string, unknown>) ?? el);
      return;
    }
    if (!typeIs(o, "Product")) return;
    const offersRaw = o.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const offer = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) ?? {};
    const price = offer.price ?? offer.lowPrice;
    const rating = o.aggregateRating as Record<string, unknown> | undefined;
    const image = Array.isArray(o.image) ? o.image[0] : o.image;
    products.push({
      name: o.name ? clean(String(o.name)) : null,
      price: price !== undefined ? Number(String(price).replace(/,/g, "")) || null : null,
      currency: (offer.priceCurrency as string) ?? null,
      availability: offer.availability ? String(offer.availability).replace(/^https?:\/\/schema\.org\//, "") : null,
      rating: rating?.ratingValue ? Number(rating.ratingValue) : null,
      reviews: rating?.reviewCount ? Number(rating.reviewCount) : rating?.ratingCount ? Number(rating.ratingCount) : null,
      brand: typeof o.brand === "object" && o.brand ? String((o.brand as Record<string, unknown>).name ?? "") || null : (o.brand as string) ?? null,
      sku: (o.sku as string) ?? null,
      url: absolutize((o.url as string) ?? (offer.url as string), base),
      image: absolutize(typeof image === "object" && image ? String((image as Record<string, unknown>).url) : (image as string), base),
    });
  };
  items.forEach(visit);
  return products;
}

function cssEscape(s: string) {
  return s.replace(/([^\w-])/g, "\\$1");
}

function stableClasses(el: Element): string[] {
  return (el.attribs.class ?? "")
    .split(/\s+/)
    // Skip generated/state classes that differ between items.
    .filter((c) => c && c.length < 40 && !/\d{3,}|^(active|selected|hover|odd|even|first|last|is-|has-|js-)/.test(c))
    .slice(0, 2);
}

function selectorFor(el: Element, $: $, depth = 0): string {
  if (el.attribs.id && !/\d{4,}/.test(el.attribs.id)) return `#${cssEscape(el.attribs.id)}`;
  const own = el.tagName + stableClasses(el).map((c) => `.${cssEscape(c)}`).join("");
  const parent = el.parent as Element | null;
  if (!parent || parent.type !== "tag" || parent.tagName === "body" || parent.tagName === "html" || depth >= 2) return own;
  return `${selectorFor(parent, $, depth + 1)} > ${own}`;
}

function signature(el: Element) {
  return el.tagName + "|" + stableClasses(el).join(".");
}

function relativeSelector(item: Element, target: Element): string {
  const parts: string[] = [];
  let cur: Element | null = target;
  while (cur && cur !== item && parts.length < 4) {
    parts.unshift(cur.tagName + stableClasses(cur).map((c) => `.${cssEscape(c)}`).join(""));
    cur = cur.parent as Element | null;
  }
  return parts.join(" ");
}

/**
 * Finds lists of similar elements (product cards, search results, posts) and
 * proposes an item selector plus fields. This powers "Auto" mode and the
 * selector suggestions in the scraper.
 */
export function findRepeatedGroups($: $, base: string, limit = 3): RepeatedGroup[] {
  const candidates: { parent: Element; members: Element[]; score: number }[] = [];
  $("body *").each((_, node) => {
    const parent = node as Element;
    const kids = parent.children.filter((c): c is Element => c.type === "tag");
    if (kids.length < 4) return;
    const groups = new Map<string, Element[]>();
    for (const k of kids) {
      if (["script", "style", "br", "option"].includes(k.tagName)) continue;
      const sig = signature(k);
      groups.set(sig, [...(groups.get(sig) ?? []), k]);
    }
    for (const members of groups.values()) {
      if (members.length < 4) continue;
      const texts = members.slice(0, 20).map((m) => clean($(m).text()));
      const avgLen = texts.reduce((a, t) => a + Math.min(t.length, 300), 0) / texts.length;
      if (avgLen < 15) continue;
      const withLink = members.slice(0, 20).filter((m) => $(m).find("a[href]").length || m.tagName === "a").length / Math.min(20, members.length);
      const withPrice = texts.filter((t) => PRICE_PATTERN.test(t)).length / texts.length;
      const withImg = members.slice(0, 20).filter((m) => $(m).find("img").length).length / Math.min(20, members.length);
      const score = Math.min(members.length, 60) * Math.log(avgLen) * (1 + withLink) * (1 + withPrice * 1.5) * (1 + withImg * 0.5);
      candidates.push({ parent, members, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score);

  const picked: RepeatedGroup[] = [];
  const used = new Set<Element>();
  for (const c of candidates) {
    if (picked.length >= limit) break;
    if (used.has(c.parent) || c.members.some((m) => used.has(m))) continue;
    const first = c.members[0]!;
    const itemSelector = `${selectorFor(c.parent, $)} > ${first.tagName}${stableClasses(first).map((x) => `.${cssEscape(x)}`).join("")}`;
    let matched: Sel;
    try { matched = $(itemSelector); } catch { continue; }
    if (matched.length < c.members.length * 0.6) continue;
    const fields = proposeFields($, first, c.members);
    const sample = c.members.slice(0, MAX_ROWS).map((m) => rowFromFields($, $(m), fields, base));
    picked.push({ itemSelector, count: matched.length, fields, sample });
    used.add(c.parent);
    c.members.forEach((m) => used.add(m));
  }
  return picked;
}

function proposeFields($: $, first: Element, members: Element[]) {
  const fields: { name: string; selector: string; attr: string }[] = [];
  const f = $(first);
  const heading = f.find("h1, h2, h3, h4, h5, h6").first();
  const link = first.tagName === "a" ? f : f.find("a[href]").filter((_, a) => clean($(a).text()).length > 3).first();
  if (heading.length) fields.push({ name: "title", selector: relativeSelector(first, heading[0] as Element), attr: "text" });
  else if (link.length && link[0] !== first) fields.push({ name: "title", selector: relativeSelector(first, link[0] as Element), attr: "text" });
  else fields.push({ name: "title", selector: ":scope", attr: "text" });
  if (link.length) fields.push({ name: "link", selector: link[0] === first ? ":scope" : relativeSelector(first, link[0] as Element), attr: "href" });
  // Price: the smallest element whose own text looks like a price, checked across a few members.
  for (const m of members.slice(0, 5)) {
    // Prefer the selling price: skip struck-through "was"/M.R.P. prices.
    const candidates = $(m).find("*").filter((_, e) => {
      const t = clean($(e).text());
      return t.length < 40 && PRICE_PATTERN.test(t) && $(e).children().length <= 3;
    });
    const isOld = (e: Element) => /^(s|del|strike)$/.test(e.tagName) || /mrp|strike|old|was|list|original|a-text-price|regular/i.test(e.attribs.class ?? "") ||
      $(e).parents("s, del, strike").length > 0;
    const priceEl = candidates.filter((_, e) => !isOld(e as Element)).first();
    if (priceEl.length) {
      fields.push({ name: "price", selector: relativeSelector(m, priceEl[0] as Element), attr: "text" });
      break;
    }
  }
  const img = f.find("img").first();
  if (img.length) fields.push({ name: "image", selector: relativeSelector(first, img[0] as Element), attr: "src" });
  return fields;
}

function rowFromFields($: $, item: Sel, fields: { name: string; selector: string; attr: string }[], base: string) {
  const row: Record<string, Cell> = {};
  for (const fd of fields) {
    const el = fd.selector === ":scope" ? item : item.find(fd.selector).first();
    let v: string | null = null;
    if (el.length) {
      if (fd.attr === "text") v = clean(el.text()).slice(0, 500) || null;
      else v = absolutize(el.attr(fd.attr) ?? el.attr("data-src"), base);
    }
    row[fd.name] = v;
    if (fd.name === "price") row.price_value = parsePrice(v)?.value ?? null;
  }
  return row;
}

function tables($: $): Dataset[] {
  const out: Dataset[] = [];
  $("table").each((i, t) => {
    if (out.length >= 5) return;
    const rows = $(t).find("tr");
    if (rows.length < 2) return;
    let headers = $(rows[0]).find("th, td").map((_, c) => clean($(c).text()) || `col_${_ + 1}`).get();
    if (headers.length < 2) return;
    headers = headers.map((h, idx) => (headers.indexOf(h) === idx ? h : `${h}_${idx + 1}`));
    const data: Record<string, Cell>[] = [];
    rows.slice(1, MAX_ROWS + 1).each((_, r) => {
      const cells = $(r).find("th, td").map((__, c) => clean($(c).text())).get();
      if (!cells.some(Boolean)) return;
      data.push(Object.fromEntries(headers.map((h, idx) => [h, cells[idx] ?? null])));
    });
    if (data.length) out.push({ name: `Table ${i + 1}`, columns: headers, rows: data });
  });
  return out;
}

export function pageMeta($: $, base: string): Record<string, Cell> {
  const meta = (name: string) => $(`meta[name="${name}"], meta[property="${name}"]`).attr("content")?.trim() ?? null;
  return {
    title: clean($("title").first().text()) || null,
    description: meta("description") ?? meta("og:description"),
    canonical: absolutize($('link[rel="canonical"]').attr("href"), base),
    "og:title": meta("og:title"),
    "og:image": absolutize(meta("og:image") ?? undefined, base),
    language: $("html").attr("lang") ?? null,
    h1: clean($("h1").first().text()) || null,
    links: $("a[href]").length,
    images: $("img").length,
    words: readableText($).split(/\s+/).filter(Boolean).length,
  };
}

/** Everything useful Scaper can find without being told where to look. */
export function autoExtract(html: string, base: string): {
  datasets: Dataset[]; meta: Record<string, Cell>; suggestions: { itemSelector: string; count: number; fields: RepeatedGroup["fields"] }[];
} {
  const $ = load(html);
  const datasets: Dataset[] = [];

  const products = productsFromJsonLd(jsonLd($), base);
  if (products.length) datasets.push({ name: "Products (structured data)", columns: Object.keys(products[0]!), rows: products.slice(0, MAX_ROWS) });

  const groups = findRepeatedGroups($, base);
  for (const [i, g] of groups.entries()) {
    const columns = Object.keys(g.sample[0] ?? {});
    datasets.push({ name: `Repeated items ${i + 1} (${g.count})`, columns, rows: g.sample });
  }

  datasets.push(...tables($));

  const seen = new Set<string>();
  const links: Record<string, Cell>[] = [];
  $("a[href]").each((_, a) => {
    const href = absolutize($(a).attr("href"), base);
    if (!href || seen.has(href) || links.length >= MAX_ROWS) return;
    seen.add(href);
    links.push({ text: clean($(a).text()).slice(0, 200) || null, url: href });
  });
  if (links.length) datasets.push({ name: "Links", columns: ["text", "url"], rows: links });

  const headings = $("h1, h2, h3").map((_, h) => ({ level: (h as Element).tagName, text: clean($(h).text()).slice(0, 300) })).get()
    .filter((h) => h.text).slice(0, MAX_ROWS);
  if (headings.length) datasets.push({ name: "Headings", columns: ["level", "text"], rows: headings });

  const images: Record<string, Cell>[] = [];
  $("img").each((_, img) => {
    const src = absolutize($(img).attr("src") ?? $(img).attr("data-src"), base);
    if (src && images.length < MAX_ROWS) images.push({ alt: $(img).attr("alt")?.trim() || null, src });
  });
  if (images.length) datasets.push({ name: "Images", columns: ["alt", "src"], rows: images });

  return {
    datasets,
    meta: pageMeta($, base),
    suggestions: groups.map((g) => ({ itemSelector: g.itemSelector, count: g.count, fields: g.fields })),
  };
}

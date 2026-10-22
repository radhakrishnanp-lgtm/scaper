import * as cheerio from "cheerio";

/** Reads a value by path: data.items[0].price, items[*].name (all), or "" for the whole document. */
export function readJsonPath(doc: unknown, path: string): unknown {
  if (!path.trim()) return doc;
  const tokens = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[(\d+|\*)\]/g) ?? [];
  let current: unknown[] = [doc];
  for (const raw of tokens) {
    const t = raw.startsWith("[") ? raw.slice(1, -1) : raw;
    const next: unknown[] = [];
    for (const c of current) {
      if (c === null || typeof c !== "object") continue;
      if (t === "*") next.push(...(Array.isArray(c) ? c : Object.values(c as object)));
      else if (Array.isArray(c) && /^\d+$/.test(t)) next.push(c[Number(t)]);
      else next.push((c as Record<string, unknown>)[t]);
    }
    current = next.filter((v) => v !== undefined);
  }
  return path.includes("*") ? current : current[0];
}

/** Stable text for comparing JSON: sorted keys, two-space indent. */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return v === undefined ? "(nothing at this path)" : typeof v === "string" ? v : JSON.stringify(sort(v), null, 2);
}

/** RSS 2.0, RSS 1.0 and Atom: one line per item ("title — link"), newest first as published. */
export function feedLines(xml: string): string[] {
  // XML mode: in HTML mode <link> is a void element and RSS links would be lost.
  const $ = cheerio.load(xml, { xml: true });
  const lines: string[] = [];
  $("item, entry").each((_, el) => {
    const item = $(el);
    const title = item.children("title").first().text().trim().replace(/\s+/g, " ");
    const link = item.children("link").first().attr("href") || item.children("link").first().text().trim() || item.children("guid").first().text().trim();
    if (title || link) lines.push([title, link].filter(Boolean).join(" — "));
  });
  return lines.slice(0, 500);
}

export function sitemapLines(xml: string, include: RegExp[]): string[] {
  const urls = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  return [...new Set(urls.filter((u) => !include.length || include.some((re) => re.test(u))))].sort().slice(0, 20_000);
}

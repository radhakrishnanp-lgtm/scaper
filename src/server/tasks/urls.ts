/** URL helpers for multi-page tasks. Pure functions, unit tested. */

const MAX_EXPANDED = 5000;

/**
 * Expands ranges and lists in a URL template:
 *   https://shop/p/{1..5}      → 5 URLs
 *   https://shop/p/{0..40..10} → 0, 10, 20, 30, 40
 *   https://shop/{tv,phones}   → 2 URLs
 */
export function expandUrlTemplate(template: string): string[] {
  const m = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?\}|\{([^{}]+,[^{}]*)\}/.exec(template);
  if (!m) return [template];
  const before = template.slice(0, m.index);
  const after = template.slice(m.index + m[0].length);
  let values: string[];
  if (m[4] !== undefined) values = m[4].split(",").map((v) => v.trim());
  else {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const step = Math.max(1, Number(m[3] ?? 1));
    values = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
      values.push(String(v));
      if (values.length >= MAX_EXPANDED) break;
    }
  }
  const out: string[] = [];
  for (const v of values) {
    for (const u of expandUrlTemplate(before + v + after)) {
      out.push(u);
      if (out.length >= MAX_EXPANDED) return out;
    }
  }
  return out;
}

/** Start URLs from a pasted list: one per line (or comma separated), templates expanded, duplicates removed. */
export function parseUrlList(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines.flatMap((l) => l.split(/[\n\r]+/))) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const u of expandUrlTemplate(line)) {
      const url = /^https?:\/\//i.test(u) ? u : `https://${u}`;
      try {
        const normalized = new URL(url).toString();
        if (!seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
      } catch { /* skip invalid lines */ }
      if (out.length >= MAX_EXPANDED) return out;
    }
  }
  return out;
}

/** Glob (* and **) or /regex/ patterns, one per line or comma separated. Empty list matches everything. */
export function compilePatterns(text: string): RegExp[] {
  return text.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const re = /^\/(.+)\/([gimsuy]*)$/.exec(p);
    if (re) {
      try { return new RegExp(re[1]!, re[2]!.replace("g", "")); } catch { return /$^/; }
    }
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    // Full URLs match whole; paths (/blog/*) match the URL's path, so * stays inside one segment; anything else matches anywhere.
    if (p.includes("://")) return new RegExp(`^${escaped}$`, "i");
    if (p.startsWith("/")) return new RegExp(`^[a-z]+://[^/]+${escaped}(?:[?#].*)?$`, "i");
    return new RegExp(escaped, "i");
  });
}

export function matchesAny(url: string, patterns: RegExp[], emptyMeans: boolean) {
  if (!patterns.length) return emptyMeans;
  return patterns.some((re) => re.test(url));
}

/** Drops #fragments and common tracking parameters, so the same page isn't visited twice. */
export function normalizeForVisit(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref_?$|mc_)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Reads <loc> entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

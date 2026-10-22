import "server-only";
import { z } from "zod";
import { chat, parseJsonReply } from "../ai/client";
import { UNTRUSTED_NOTE } from "../ai/extract";
import { bus } from "../bus";
import { findRepeatedGroups } from "../extract/auto";
import { load } from "../extract/dom";
import { fetchPage } from "../fetcher";
import { configuredChannels, deliver } from "../notify";
import type { DealFilters, ProductAlerts } from "@/lib/schemas";
import { getDealSearch, recordDealSearchRun, type DealSearch } from "../repo/deal-searches";
import { audit } from "../repo/events";
import { createProduct, getProduct, getProductByUrl, priceHistory, recordProductCheck, type Product } from "../repo/products";
import { amazonAsin, canonicalProductUrl, isAmazon, listingFromRows, parseAmazonListing, parseProduct, type ListingItem } from "./parsers";
import { dealStats, type DealStats } from "./score";

export function withStats(p: Product): Product & { stats: DealStats } {
  return { ...p, stats: dealStats(priceHistory(p.id, 3650), p.current_price, p.list_price) };
}

const money = (v: number, currency: string | null) =>
  currency ? new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(v) : v.toLocaleString("en-IN");

/**
 * Checks one product page, stores a price point, and alerts according to the product's rules:
 * target price reached, a % drop since the last check, a new all-time low, or back in stock.
 */
export async function refreshProduct(p: Product, hooks: { signal?: AbortSignal } = {}) {
  const before = p.current_price;
  const wasInStock = p.in_stock;
  const history = priceHistory(p.id, 3650);
  const nextCheckAt = new Date(Date.now() + p.interval_minutes * 60_000 * (1 + Math.random() * 0.1)).toISOString();
  try {
    const page = await fetchPage(p.url, "browser", { signal: hooks.signal });
    const parsed = parseProduct(page.html, page.finalUrl);
    if (parsed.price === null) throw new Error("No price found on the page (the item may be unavailable or the layout changed).");
    recordProductCheck(p.id, { ...parsed, error: null, nextCheckAt });
    const updated = getProduct(p.id)!;
    const price = parsed.price;
    const name = updated.title?.slice(0, 80) ?? "product";
    const channels = p.alerts.channels ?? configuredChannels();
    const allTimeLow = history.length ? Math.min(...history.map((h) => h.price)) : null;
    const alerts: { title: string; body: string }[] = [];

    if (p.target_price && price <= p.target_price && (before === null || before > p.target_price)) {
      alerts.push({ title: `Target price hit: ${name}`, body: `Now ${money(price, updated.currency)} (your target: ${money(p.target_price, updated.currency)}).` });
    }
    if (p.alerts.dropPercent && before !== null && before > 0 && ((before - price) / before) * 100 >= p.alerts.dropPercent) {
      alerts.push({ title: `Price dropped ${Math.round(((before - price) / before) * 100)}%: ${name}`, body: `${money(price, updated.currency)}, down from ${money(before, updated.currency)}.` });
    }
    if (p.alerts.newLow && allTimeLow !== null && history.length >= 3 && price < allTimeLow && before !== null && price <= before * 0.99) {
      alerts.push({ title: `New lowest price: ${name}`, body: `${money(price, updated.currency)}, the lowest Scaper has seen (previous low ${money(allTimeLow, updated.currency)}).` });
    }
    if (p.alerts.backInStock && wasInStock === false && parsed.inStock === true) {
      alerts.push({ title: `Back in stock: ${name}`, body: `Available again at ${money(price, updated.currency)}.` });
    }
    // One message per check, even when several rules fire.
    if (alerts.length) {
      await deliver({ kind: "price", title: alerts[0]!.title, body: alerts.map((a, i) => (i === 0 ? a.body : `${a.title}. ${a.body}`)).join("\n"), url: p.url, productId: p.id, data: { price, previous: before } }, channels);
    }
    bus.emit({ type: "product", id: p.id });
    return { ok: true as const, product: withStats(updated), alerts: alerts.length };
  } catch (e) {
    const message = (e as Error).message;
    // Back off harder on failures so a blocked store isn't hit repeatedly.
    recordProductCheck(p.id, { error: message, nextCheckAt: new Date(Date.now() + Math.max(p.interval_minutes, 120) * 2 * 60_000).toISOString() });
    audit("product.failed", { productId: p.id, error: message }, "warn");
    bus.emit({ type: "product", id: p.id });
    return { ok: false as const, error: message, product: withStats(getProduct(p.id)!) };
  }
}

export async function trackProduct(input: { url: string; targetPrice?: number | null; intervalMinutes: number; tags?: string[]; alerts?: ProductAlerts }, opts: { refresh?: boolean } = {}) {
  const url = canonicalProductUrl(input.url);
  const existing = getProductByUrl(url);
  if (existing) return { created: false, product: withStats(existing) };
  const p = createProduct({ url, source: isAmazon(url) ? "amazon" : "web", externalId: amazonAsin(url), targetPrice: input.targetPrice ?? null, intervalMinutes: input.intervalMinutes, tags: input.tags, alerts: input.alerts });
  audit("product.tracked", { productId: p.id, host: new URL(url).hostname });
  if (opts.refresh === false) return { created: true, product: withStats(p) };
  const first = await refreshProduct(p);
  return { created: true, product: first.product, error: first.ok ? undefined : first.error };
}

export type ScannedItem = ListingItem & { tracked: boolean; stats: DealStats | null; aiNote?: string };

const aiPickSchema = z.object({ picks: z.array(z.object({ index: z.number().int(), note: z.string().max(300) })).max(50) });

/**
 * Reads a listing page (Amazon search/deals page, or any store's category page)
 * and ranks items by discount, using Scaper's own history for tracked items.
 */
export function applyDealFilters<T extends ListingItem>(items: T[], f: Partial<DealFilters>): T[] {
  const inc = f.include?.trim() ? f.include.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : [];
  const exc = f.exclude?.trim() ? f.exclude.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : [];
  return items.filter((i) => {
    const t = i.title.toLowerCase();
    if ((i.discount ?? 0) < (f.minDiscount ?? 0)) return false;
    if (f.maxPrice && (i.price === null || i.price > f.maxPrice)) return false;
    if (f.minRating && (i.rating === null || i.rating < f.minRating)) return false;
    if (f.minReviews && (i.reviews === null || i.reviews < f.minReviews)) return false;
    if (f.hideSponsored && i.sponsored) return false;
    if (inc.length && !inc.some((w) => t.includes(w))) return false;
    if (exc.some((w) => t.includes(w))) return false;
    return true;
  });
}

export async function scanListing(input: { url: string; minDiscount: number; rankWithAi: boolean; filters?: Partial<DealFilters>; signal?: AbortSignal }) {
  const page = await fetchPage(input.url, "browser", { scroll: true, signal: input.signal });
  const amazonMarkup = isAmazon(page.finalUrl) || page.html.includes('data-component-type="s-search-result"');
  let items = amazonMarkup ? parseAmazonListing(page.html, page.finalUrl) : [];
  if (!items.length) {
    const groups = findRepeatedGroups(load(page.html), page.finalUrl, 1);
    items = groups[0] ? listingFromRows(groups[0].sample) : [];
  }
  let scanned: ScannedItem[] = items.map((it) => {
    const tracked = it.url ? getProductByUrl(canonicalProductUrl(it.url)) : null;
    return { ...it, tracked: Boolean(tracked), stats: tracked ? dealStats(priceHistory(tracked.id), it.price, it.listPrice) : null };
  });
  scanned = applyDealFilters(scanned, { ...input.filters, minDiscount: Math.max(input.minDiscount, input.filters?.minDiscount ?? 0) });
  scanned.sort((a, b) => (b.stats?.score ?? -1) - (a.stats?.score ?? -1) || (b.discount ?? 0) - (a.discount ?? 0));

  const notes: string[] = [...page.notes];
  if (input.rankWithAi && scanned.length) {
    try {
      const top = scanned.slice(0, 40);
      const compact = top.map((i, idx) => ({ index: idx, title: i.title.slice(0, 120), price: i.price, mrp: i.listPrice, discount: i.discount, rating: i.rating, reviews: i.reviews, sponsored: i.sponsored }));
      const res = await chat([
        { role: "system", content: `You are a careful shopping analyst. Given products, pick the best real deals. Prefer big discounts on well-rated items with many reviews. Flag discounts that look inflated. Reply with JSON {"picks":[{"index":0,"note":"short reason"}]}, best first, at most 10. ${UNTRUSTED_NOTE}` },
        { role: "user", content: `<page>${JSON.stringify(compact)}</page>` },
      ], { model: "fast", json: true, temperature: 0, maxTokens: 900 });
      const picks = aiPickSchema.parse(parseJsonReply(res.content)).picks.filter((p) => top[p.index]);
      const chosen = new Set(picks.map((p) => p.index));
      const ranked = picks.map((p) => ({ ...top[p.index]!, aiNote: p.note }));
      scanned = [...ranked, ...top.filter((_, i) => !chosen.has(i)), ...scanned.slice(40)];
      notes.push(`AI ranking by ${res.model}.`);
    } catch (e) {
      notes.push(`AI ranking skipped: ${(e as Error).message}`);
    }
  }
  audit("deals.scanned", { host: new URL(input.url).hostname, items: scanned.length });
  return { items: scanned.slice(0, 200), total: items.length, title: page.title, notes };
}

const itemKey = (i: ListingItem) => i.externalId ?? i.url;

/** Runs a saved deal search and alerts on deals it has not shown before. */
export async function runDealSearch(id: string, hooks: { signal?: AbortSignal; log?: (level: "info" | "warn", m: string) => void } = {}) {
  const s: DealSearch | null = getDealSearch(id);
  if (!s) throw new Error("Deal search not found.");
  try {
    const r = await scanListing({ url: s.url, minDiscount: s.filters.minDiscount, rankWithAi: s.rank_with_ai, filters: s.filters, signal: hooks.signal });
    const seen = new Set(s.seen);
    const fresh = r.items.filter((i) => !seen.has(itemKey(i)));
    hooks.log?.("info", `${r.items.length} deal(s) match, ${fresh.length} new.`);
    recordDealSearchRun(id, { status: "ok", items: r.items as unknown as Record<string, unknown>[], newKeys: fresh.map(itemKey) });
    // The first run only records what exists; later runs alert on what is new.
    if (s.notify_new && s.last_run_at && fresh.length) {
      const lines = fresh.slice(0, 8).map((i) => `${i.discount ? `${i.discount}% off · ` : ""}${i.price !== null ? money(i.price, i.currency) + " · " : ""}${i.title.slice(0, 90)}`);
      await deliver({ kind: "deal", title: `${s.name}: ${fresh.length} new deal${fresh.length === 1 ? "" : "s"}`, body: lines.join("\n"), url: s.url, data: { dealSearchId: id } }, configuredChannels());
    }
    bus.emit({ type: "deal_search", id });
    return { total: r.items.length, fresh: fresh.length };
  } catch (e) {
    recordDealSearchRun(id, { status: "error", items: s.last_result ?? [], newKeys: [] });
    bus.emit({ type: "deal_search", id });
    throw e;
  }
}

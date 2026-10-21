import "server-only";
import { z } from "zod";
import { chat, parseJsonReply } from "../ai/client";
import { UNTRUSTED_NOTE } from "../ai/extract";
import { bus } from "../bus";
import { findRepeatedGroups } from "../extract/auto";
import { load } from "../extract/dom";
import { fetchPage } from "../fetcher";
import { deliver } from "../notify";
import { audit } from "../repo/events";
import { createProduct, getProduct, getProductByUrl, priceHistory, recordProductCheck, type Product } from "../repo/products";
import { getSettings } from "../repo/settings";
import { canonicalProductUrl, isAmazon, listingFromRows, parseAmazonListing, parseProduct, type ListingItem } from "./parsers";
import { dealStats, type DealStats } from "./score";

export function withStats(p: Product): Product & { stats: DealStats } {
  return { ...p, stats: dealStats(priceHistory(p.id, 365), p.current_price, p.list_price) };
}

function alertChannels() {
  const n = getSettings().notifications;
  return { desktop: true, webhook: Boolean(n.webhookUrl), telegram: Boolean(n.telegramBotToken && n.telegramChatId) };
}

const money = (v: number, currency: string | null) =>
  currency ? new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(v) : v.toLocaleString("en-IN");

/** Checks one product page, stores a price point, and alerts on a target hit or a new low. */
export async function refreshProduct(p: Product) {
  const before = p.current_price;
  const history = priceHistory(p.id, 90);
  const nextCheckAt = new Date(Date.now() + p.interval_minutes * 60_000 * (1 + Math.random() * 0.1)).toISOString();
  try {
    const page = await fetchPage(p.url, "browser");
    const parsed = parseProduct(page.html, page.finalUrl);
    if (parsed.price === null) throw new Error("No price found on the page (the item may be unavailable or the layout changed).");
    recordProductCheck(p.id, { ...parsed, error: null, nextCheckAt });
    const updated = getProduct(p.id)!;
    const price = parsed.price;
    const prevLow = history.length ? Math.min(...history.map((h) => h.price)) : null;

    if (p.target_price && price <= p.target_price && (before === null || before > p.target_price)) {
      await deliver({ kind: "price", title: `Target price hit: ${updated.title?.slice(0, 80) ?? "product"}`,
        body: `Now ${money(price, updated.currency)} (your target: ${money(p.target_price, updated.currency)}).`, url: p.url, productId: p.id }, alertChannels());
    } else if (prevLow !== null && history.length >= 3 && price < prevLow && before !== null && price <= before * 0.97) {
      await deliver({ kind: "price", title: `New low: ${updated.title?.slice(0, 80) ?? "product"}`,
        body: `${money(price, updated.currency)}, down from ${money(before, updated.currency)}. Lowest in 90 days.`, url: p.url, productId: p.id }, alertChannels());
    }
    bus.emit({ type: "product", id: p.id });
    return { ok: true as const, product: withStats(updated) };
  } catch (e) {
    const message = (e as Error).message;
    // Back off harder on failures so a blocked store isn't hit repeatedly.
    recordProductCheck(p.id, { error: message, nextCheckAt: new Date(Date.now() + Math.max(p.interval_minutes, 120) * 2 * 60_000).toISOString() });
    audit("product.failed", { productId: p.id, error: message }, "warn");
    bus.emit({ type: "product", id: p.id });
    return { ok: false as const, error: message, product: withStats(getProduct(p.id)!) };
  }
}

export async function trackProduct(input: { url: string; targetPrice?: number | null; intervalMinutes: number }) {
  const url = canonicalProductUrl(input.url);
  const existing = getProductByUrl(url);
  if (existing) return { created: false, product: withStats(existing) };
  const p = createProduct({ url, source: isAmazon(url) ? "amazon" : "web", externalId: null, targetPrice: input.targetPrice ?? null, intervalMinutes: input.intervalMinutes });
  audit("product.tracked", { productId: p.id, host: new URL(url).hostname });
  const first = await refreshProduct(p);
  return { created: true, product: first.product, error: first.ok ? undefined : first.error };
}

export type ScannedItem = ListingItem & { tracked: boolean; stats: DealStats | null; aiNote?: string };

const aiPickSchema = z.object({ picks: z.array(z.object({ index: z.number().int(), note: z.string().max(300) })).max(50) });

/**
 * Reads a listing page (Amazon search/deals page, or any store's category page)
 * and ranks items by discount, using Scaper's own history for tracked items.
 */
export async function scanListing(input: { url: string; minDiscount: number; rankWithAi: boolean }) {
  const page = await fetchPage(input.url, "browser", { scroll: true });
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
  scanned = scanned.filter((i) => (i.discount ?? 0) >= input.minDiscount);
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

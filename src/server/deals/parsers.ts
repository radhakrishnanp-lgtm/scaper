import type { Cell } from "@/lib/types";
import { productsFromJsonLd, jsonLd } from "../extract/auto";
import { absolutize, clean, load, type $ } from "../extract/dom";
import { discountPercent, parsePrice } from "../extract/price";

export type ParsedProduct = {
  title: string | null; price: number | null; listPrice: number | null; currency: string | null;
  rating: number | null; reviewCount: number | null; inStock: boolean | null; image: string | null; externalId: string | null;
};

const AMAZON_HOST = /(^|\.)amazon\.(com|in|co\.uk|de|fr|it|es|ca|com\.au|co\.jp|ae|sa|nl|se|pl|com\.br|com\.mx|sg|com\.tr|eg|com\.be)$/i;

export function isAmazon(url: string) {
  try { return AMAZON_HOST.test(new URL(url).hostname); } catch { return false; }
}

export function amazonAsin(url: string): string | null {
  return /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url)?.[1]?.toUpperCase() ?? null;
}

/** Short, stable product URL without tracking parameters, so the same item is never tracked twice. */
export function canonicalProductUrl(url: string): string {
  const u = new URL(url);
  if (isAmazon(url)) {
    const asin = amazonAsin(url);
    if (asin) return `${u.protocol}//${u.hostname}/dp/${asin}`;
  }
  for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref|tag|fbclid|gclid|psc|smid|th$|qid|sr$|keywords|crid|sprefix|spm)/i.test(p)) u.searchParams.delete(p);
  u.hash = "";
  return u.toString();
}

function firstPrice($: $, selectors: string[]): number | null {
  for (const s of selectors) {
    const t = clean($(s).first().text());
    const p = parsePrice(t);
    if (p) return p.value;
  }
  return null;
}

function num(text: string | undefined | null): number | null {
  if (!text) return null;
  const m = /[\d][\d,.]*/.exec(text);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

export function parseAmazonProduct(html: string, url: string): ParsedProduct {
  const $ = load(html);
  const price = firstPrice($, [
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#apex_desktop .a-price:not(.a-text-price) .a-offscreen",
    "#corePrice_desktop .a-price:not(.a-text-price) .a-offscreen",
    "#priceblock_dealprice", "#priceblock_ourprice", "#price_inside_buybox", "#kindle-price", ".a-price.priceToPay .a-offscreen",
  ]);
  const listPrice = firstPrice($, [
    "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price.a-text-price .a-offscreen",
    "#corePrice_desktop .a-text-price .a-offscreen",
    "#apex_desktop .a-text-price .a-offscreen",
    "span[data-a-strike='true'] .a-offscreen", "#listPrice", "#priceblock_listprice",
  ]);
  const ratingText = $("#acrPopover").attr("title") ?? $("#acrPopover .a-icon-alt").first().text() ?? $("i.a-icon-star span.a-icon-alt").first().text();
  const availability = clean($("#availability").text()).toLowerCase();
  const img = $("#landingImage");
  const ld = productsFromJsonLd(jsonLd($), url)[0];
  return {
    title: clean($("#productTitle").text()) || (ld?.name as string) || clean($("title").text()) || null,
    price: price ?? ((ld?.price as number) || null),
    listPrice: listPrice && price && listPrice > price ? listPrice : null,
    currency: parsePrice($(".a-price-symbol").first().text() + "1")?.currency ?? (ld?.currency as string) ?? (url.includes("amazon.in") ? "INR" : null),
    rating: num(ratingText),
    reviewCount: num($("#acrCustomerReviewText").first().text()),
    inStock: availability ? !/unavailable|out of stock|currently not available/.test(availability) : price !== null,
    image: absolutize(img.attr("data-old-hires") || img.attr("src"), url),
    externalId: amazonAsin(url) ?? ($("#ASIN").attr("value") || null),
  };
}

/** Any store: schema.org JSON-LD first, then common microdata and meta tags. */
export function parseGenericProduct(html: string, url: string): ParsedProduct {
  const $ = load(html);
  const ld = productsFromJsonLd(jsonLd($), url)[0];
  const metaPrice = $('meta[itemprop="price"]').attr("content") ?? $('[itemprop="price"]').first().attr("content") ??
    $('meta[property="product:price:amount"], meta[property="og:price:amount"]').attr("content") ?? clean($('[itemprop="price"]').first().text());
  const price = (ld?.price as number) || parsePrice(metaPrice)?.value || null;
  return {
    title: (ld?.name as string) ?? ($('meta[property="og:title"]').attr("content") || clean($("h1").first().text()) || clean($("title").text()) || null),
    price,
    listPrice: null,
    currency: (ld?.currency as string) ?? $('meta[itemprop="priceCurrency"], meta[property="product:price:currency"]').attr("content") ?? parsePrice(metaPrice)?.currency ?? null,
    rating: (ld?.rating as number) ?? null,
    reviewCount: (ld?.reviews as number) ?? null,
    inStock: ld?.availability ? /InStock|LimitedAvailability|PreOrder/i.test(String(ld.availability)) : null,
    image: (ld?.image as string) ?? absolutize($('meta[property="og:image"]').attr("content"), url),
    externalId: (ld?.sku as string) ?? null,
  };
}

export function parseProduct(html: string, url: string): ParsedProduct {
  // Amazon layouts also appear on regional domains and saved copies, so detect by markup too.
  if (isAmazon(url) || /id="productTitle"|id="corePriceDisplay_desktop_feature_div"/.test(html)) {
    const p = parseAmazonProduct(html, url);
    if (p.price !== null || p.title) return p;
  }
  return parseGenericProduct(html, url);
}

export type ListingItem = {
  title: string; url: string; price: number | null; listPrice: number | null; discount: number | null; currency: string | null;
  rating: number | null; reviews: number | null; image: string | null; externalId: string | null; sponsored: boolean;
};

/** Reads an Amazon search, category or deals listing page. Falls back to generic repeated-card detection elsewhere. */
export function parseAmazonListing(html: string, base: string): ListingItem[] {
  const $ = load(html);
  const items: ListingItem[] = [];
  const seen = new Set<string>();
  $('[data-component-type="s-search-result"][data-asin], div[data-asin].s-result-item').each((_, el) => {
    const card = $(el);
    const asin = card.attr("data-asin");
    if (!asin || seen.has(asin)) return;
    const title = clean(card.find("h2 span").first().text() || card.find("h2").first().text());
    if (!title) return;
    seen.add(asin);
    const priceParsed = parsePrice(card.find(".a-price:not(.a-text-price) .a-offscreen").first().text());
    const price = priceParsed?.value ?? null;
    const lpRaw = parsePrice(card.find(".a-price.a-text-price .a-offscreen").first().text())?.value ?? null;
    const listPrice = lpRaw && price && lpRaw > price ? lpRaw : null;
    const reviewsLabel = card.find('[aria-label$="ratings"], [aria-label$="rating"]').first().attr("aria-label") ??
      card.find("span.a-size-base.s-underline-text").first().text();
    const u = new URL(base);
    items.push({
      title,
      url: `${u.protocol}//${u.hostname}/dp/${asin}`,
      price,
      listPrice,
      discount: discountPercent(price, listPrice),
      currency: priceParsed?.currency ?? null,
      rating: num(card.find("span.a-icon-alt").first().text()),
      reviews: num(reviewsLabel),
      image: absolutize(card.find("img.s-image").attr("src"), base),
      externalId: asin,
      sponsored: /sponsored/i.test(card.find(".puis-label-popover, .s-label-popover-default, [aria-label*='Sponsored']").text() + (card.attr("class") ?? "")),
    });
  });
  return items;
}

export function listingFromRows(rows: Record<string, Cell>[]): ListingItem[] {
  return rows.filter((r) => r.title && r.link).map((r) => ({
    title: String(r.title), url: String(r.link), price: (r.price_value as number) ?? null, listPrice: null, discount: null,
    currency: typeof r.price === "string" ? parsePrice(r.price)?.currency ?? null : null,
    rating: null, reviews: null, image: (r.image as string) ?? null, externalId: null, sponsored: false,
  }));
}

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoExtract } from "@/server/extract/auto";
import { extractWithSelectors } from "@/server/extract/selectors";
import { canonicalProductUrl, parseAmazonListing, parseAmazonProduct, parseProduct } from "@/server/deals/parsers";
import { readTarget, dropIgnored } from "@/server/watch/runner";

const fx = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const BASE = "https://shop.example.com/headphones";

describe("autoExtract", () => {
  const { datasets, meta, suggestions } = autoExtract(fx("listing.html"), BASE);

  it("reads JSON-LD products", () => {
    const ld = datasets.find((d) => d.name.startsWith("Products"));
    expect(ld?.rows[0]).toMatchObject({ name: "Aria Wireless", price: 2499, currency: "INR", rating: 4.3, reviews: 812 });
  });

  it("finds the repeated product cards with absolute links and numeric prices", () => {
    const rep = datasets.find((d) => d.name.startsWith("Repeated items"));
    expect(rep?.rows).toHaveLength(5);
    expect(rep?.rows[0]).toMatchObject({ title: "Aria Wireless Headphones", link: "https://shop.example.com/p/aria", price_value: 2499 });
    expect(suggestions[0]?.itemSelector).toContain("#results");
  });

  it("extracts tables and page meta", () => {
    expect(datasets.find((d) => d.name === "Table 1")?.rows).toEqual([{ Model: "Aria", Battery: "30h" }, { Model: "Bolt", Battery: "8h" }]);
    expect(meta).toMatchObject({ title: "Gadget Store – Headphones", description: "Headphones at great prices", language: "en", h1: "Headphones" });
  });
});

describe("extractWithSelectors", () => {
  it("returns one row per item with relative fields", () => {
    const ds = extractWithSelectors(fx("listing.html"), BASE, {
      itemSelector: ".card",
      fields: [
        { name: "name", selector: "h2", attr: "text", multiple: false },
        { name: "price", selector: ".price", attr: "text", multiple: false },
        { name: "url", selector: "a", attr: "href", multiple: false },
      ],
    });
    expect(ds.rows).toHaveLength(5);
    expect(ds.rows[1]).toEqual({ name: "Bolt Sport Earbuds", price: "₹1,299", price_value: 1299, url: "https://shop.example.com/p/bolt" });
  });

  it("zips multiple fields without an item selector", () => {
    const ds = extractWithSelectors(fx("listing.html"), BASE, { fields: [{ name: "name", selector: "h2", attr: "text", multiple: true }] });
    expect(ds.rows.map((r) => r.name)).toHaveLength(5);
  });

  it("reports an invalid selector clearly", () => {
    expect(() => extractWithSelectors("<p>x</p>", BASE, { fields: [{ name: "a", selector: "p[[", attr: "text", multiple: false }] })).toThrow(/not a valid CSS selector/);
  });
});

describe("Amazon parsers", () => {
  it("parses a product page", () => {
    const p = parseAmazonProduct(fx("amazon-product.html"), "https://www.amazon.in/dp/B0TESTASIN?ref=x");
    expect(p).toMatchObject({ title: "Aria Wireless Headphones with 30h Battery", price: 2499, listPrice: 4999, currency: "INR", rating: 4.3, reviewCount: 12345, inStock: true, externalId: "B0TESTASIN" });
    expect(p.image).toBe("https://m.media-amazon.com/images/I/large.jpg");
  });

  it("parses search results with discounts and sponsored flags", () => {
    const items = parseAmazonListing(fx("amazon-search.html"), "https://www.amazon.in/s?k=earbuds");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: "Aria Buds Pro", url: "https://www.amazon.in/dp/B0AAAAAAA1", price: 1499, listPrice: 4999, discount: 70, rating: 4.4, reviews: 2301, sponsored: false });
    expect(items[1]?.sponsored).toBe(true);
    expect(items[2]).toMatchObject({ discount: null, listPrice: null });
  });

  it("canonicalizes product URLs", () => {
    expect(canonicalProductUrl("https://www.amazon.in/Some-Name/dp/B0TESTASIN/ref=sr_1_3?keywords=x&qid=1")).toBe("https://www.amazon.in/dp/B0TESTASIN");
    expect(canonicalProductUrl("https://shop.example.com/p/1?utm_source=a&color=red#top")).toBe("https://shop.example.com/p/1?color=red");
  });

  it("falls back to structured data on other shops", () => {
    expect(parseProduct(fx("listing.html"), BASE)).toMatchObject({ price: 2499, currency: "INR" });
  });
});

describe("watch targets", () => {
  it("reads a selector's text and number", () => {
    const r = readTarget(fx("listing.html"), BASE, { type: "selector", selector: ".card:first-child .price" });
    expect(r).toEqual({ content: "₹2,499", value: 2499 });
  });

  it("detects an Amazon price automatically", () => {
    expect(readTarget(fx("amazon-product.html"), "https://www.amazon.in/dp/B0TESTASIN", { type: "price", selector: "" }).value).toBe(2499);
  });

  it("fails clearly when the selector is gone", () => {
    expect(() => readTarget("<p>hi</p>", BASE, { type: "selector", selector: ".nope" })).toThrow(/matched nothing/);
  });

  it("drops ignored lines", () => {
    expect(dropIgnored("Price 10\nUpdated 5 min ago\nStock 3", ["updated"])).toBe("Price 10\nStock 3");
  });
});

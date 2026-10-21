import { describe, expect, it } from "vitest";
import { discountPercent, parsePrice } from "@/server/extract/price";
import { diffLines, summarizeDiff } from "@/server/watch/diff";
import { evaluate } from "@/server/watch/conditions";
import { dealStats } from "@/server/deals/score";
import { toCsv } from "@/lib/csv";
import { createSessionToken, verifySessionToken } from "@/lib/session-token";
import { urlSchema, watcherSchema } from "@/lib/schemas";

describe("parsePrice", () => {
  it.each([
    ["₹1,29,999.00", 129999, "INR"],
    ["$1,299.99", 1299.99, "USD"],
    ["1.299,00 €", 1299, "EUR"],
    ["Rs. 499", 499, "INR"],
    ["£12.50", 12.5, "GBP"],
    ["12,50 €", 12.5, "EUR"],
    ["INR 2,499", 2499, "INR"],
  ])("%s", (text, value, currency) => {
    expect(parsePrice(text)).toEqual({ value, currency });
  });

  it("returns null without a number", () => {
    expect(parsePrice("Currently unavailable")).toBeNull();
    expect(parsePrice("")).toBeNull();
  });

  it("computes discounts", () => {
    expect(discountPercent(2499, 4999)).toBe(50);
    expect(discountPercent(100, 90)).toBeNull();
  });
});

describe("diffLines", () => {
  it("counts added and removed lines with context", () => {
    const d = diffLines("a\nb\nc\nd", "a\nb\nX\nd\ne");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.patch.filter((p) => p.op === "+").map((p) => p.text)).toEqual(["X", "e"]);
    expect(summarizeDiff(d)).toContain("2 lines added, 1 removed.");
  });

  it("handles identical input", () => {
    expect(diffLines("same", "same")).toMatchObject({ added: 0, removed: 0 });
  });

  it("stays bounded on huge input", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const b = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
    const d = diffLines(a, b);
    expect(d.added).toBe(5000);
    expect(d.patch.length).toBeLessThanOrEqual(300);
  });
});

describe("evaluate", () => {
  const prev = (content: string, value: number | null, met = false) => ({ content, value, met });

  it("any_change alerts on change but not on the baseline", () => {
    expect(evaluate({ type: "any_change" }, null, { content: "a", value: null }, false).notify).toBe(false);
    expect(evaluate({ type: "any_change" }, prev("a", null), { content: "b", value: null }, true).notify).toBe(true);
  });

  it("state conditions alert once when they become true", () => {
    const c = { type: "contains" as const, text: "in stock" };
    expect(evaluate(c, prev("Sold out", null), { content: "Now In Stock", value: null }, true)).toMatchObject({ met: true, notify: true });
    expect(evaluate(c, prev("Now In Stock", null, true), { content: "Now In Stock!", value: null }, true)).toMatchObject({ met: true, notify: false });
  });

  it("below and drop_percent use numbers", () => {
    expect(evaluate({ type: "below", value: 2000 }, prev("", 2100), { content: "", value: 1999 }, true).notify).toBe(true);
    expect(evaluate({ type: "drop_percent", percent: 10 }, prev("", 1000), { content: "", value: 899 }, true).notify).toBe(true);
    expect(evaluate({ type: "drop_percent", percent: 10 }, prev("", 1000), { content: "", value: 950 }, true).notify).toBe(false);
  });

  it("ai condition follows the verdict", () => {
    expect(evaluate({ type: "ai", question: "new backend job?" }, prev("a", null), { content: "b", value: null }, true, { match: true, reason: "New job" })).toMatchObject({ notify: true, reason: "New job" });
    expect(evaluate({ type: "ai", question: "new backend job?" }, prev("a", null), { content: "b", value: null }, true, { match: false, reason: "" }).notify).toBe(false);
  });
});

describe("dealStats", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const day = (d: number) => new Date(now - d * 86400_000).toISOString();

  it("waits for history before judging", () => {
    const s = dealStats([{ price: 2499, created_at: day(0) }], 2499, 4999, now);
    expect(s.verdict).toBe("collecting");
    expect(s.claimedDiscount).toBe(50);
  });

  it("flags a real low and an inflated M.R.P.", () => {
    const history = [3000, 3100, 2950, 3050, 3000, 2999].map((price, i) => ({ price, created_at: day(30 - i * 5) }));
    const s = dealStats([...history, { price: 2400, created_at: day(0) }], 2400, 9999, now);
    expect(s.isLowest).toBe(true);
    expect(s.realDiscount).toBe(20);
    expect(s.inflatedMrp).toBe(true);
    expect(s.verdict).toBe("great");
  });

  it("says wait when the price is high for this item", () => {
    const history = [1000, 1010, 990, 1005].map((price, i) => ({ price, created_at: day(20 - i * 5) }));
    expect(dealStats([...history, { price: 1010, created_at: day(0) }], 1010, null, now).verdict).toBe("wait");
  });
});

describe("csv", () => {
  it("escapes quotes, commas and formula injection", () => {
    expect(toCsv(["a", "b"], [{ a: 'x,"y"', b: "=SUM(A1)" }])).toBe('a,b\r\n"x,""y""",\'=SUM(A1)');
  });
});

describe("session token", () => {
  const secret = "s".repeat(40);
  it("verifies its own tokens and rejects tampering or expiry", async () => {
    const t = await createSessionToken(secret);
    expect(await verifySessionToken(secret, t)).toBe(true);
    expect(await verifySessionToken("x".repeat(40), t)).toBe(false);
    expect(await verifySessionToken(secret, t.replace(/^\d/, "9"))).toBe(false);
    expect(await verifySessionToken(secret, await createSessionToken(secret, -1))).toBe(false);
  });
});

describe("schemas", () => {
  it("adds https:// and rejects non-web URLs", () => {
    expect(urlSchema.parse("example.com/a")).toBe("https://example.com/a");
    expect(urlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(urlSchema.safeParse("file:///etc/passwd").success).toBe(false);
  });

  it("validates watcher input", () => {
    const bad = watcherSchema.safeParse({ name: "", url: "x", target: { type: "selector", selector: "" }, condition: { type: "below" }, notify: {}, intervalMinutes: 0 });
    expect(bad.success).toBe(false);
  });
});

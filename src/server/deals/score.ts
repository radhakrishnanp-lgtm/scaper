import { discountPercent } from "../extract/price";

export type PricePointLite = { price: number; created_at: string; in_stock?: number | null };

export type DealStats = {
  current: number | null;
  low: number | null;
  high: number | null;
  avg30: number | null;
  points: number;
  daysTracked: number;
  claimedDiscount: number | null;
  realDiscount: number | null;
  isLowest: boolean;
  inflatedMrp: boolean;
  score: number | null;
  verdict: "great" | "good" | "fair" | "wait" | "collecting";
  summary: string;
  /** Keepa-style extras: all-time extremes with dates, longer averages, stock and the last move. */
  allTimeLow: { price: number; at: string } | null;
  allTimeHigh: { price: number; at: string } | null;
  avg90: number | null;
  avg180: number | null;
  avg365: number | null;
  outOfStockPercent: number | null;
  lastChange: { from: number; to: number; at: string } | null;
  drops: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const avgOf = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function extras(history: PricePointLite[], nowMs: number) {
  let low: PricePointLite | null = null;
  let high: PricePointLite | null = null;
  let drops = 0;
  let lastChange: DealStats["lastChange"] = null;
  for (const [i, h] of history.entries()) {
    if (!low || h.price < low.price) low = h;
    if (!high || h.price > high.price) high = h;
    const prev = history[i - 1];
    if (prev && prev.price !== h.price) {
      if (h.price < prev.price) drops++;
      lastChange = { from: prev.price, to: h.price, at: h.created_at };
    }
  }
  const within = (days: number) => history.filter((h) => nowMs - Date.parse(h.created_at) <= days * DAY).map((h) => h.price);
  const stockKnown = history.filter((h) => h.in_stock === 0 || h.in_stock === 1);
  return {
    allTimeLow: low ? { price: low.price, at: low.created_at } : null,
    allTimeHigh: high ? { price: high.price, at: high.created_at } : null,
    avg90: avgOf(within(90)), avg180: avgOf(within(180)), avg365: avgOf(within(365)),
    outOfStockPercent: stockKnown.length ? Math.round((stockKnown.filter((h) => h.in_stock === 0).length / stockKnown.length) * 1000) / 10 : null,
    lastChange, drops,
  };
}

const DAY = 86400_000;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Judges a price against Scaper's own snapshots (Keepa-style), not against the
 * store's "M.R.P.", which is often inflated. Score 0–100: higher is a better time to buy.
 */
export function dealStats(history: PricePointLite[], current: number | null, listPrice: number | null, nowMs = Date.now()): DealStats {
  const prices = history.map((h) => h.price);
  const recent = history.filter((h) => nowMs - Date.parse(h.created_at) <= 90 * DAY).map((h) => h.price);
  const last30 = history.filter((h) => nowMs - Date.parse(h.created_at) <= 30 * DAY).map((h) => h.price);
  const first = history[0] ? Date.parse(history[0].created_at) : nowMs;
  const daysTracked = Math.max(0, (nowMs - first) / DAY);
  const claimedDiscount = discountPercent(current, listPrice);
  const base: DealStats = {
    current, low: prices.length ? Math.min(...prices) : null, high: prices.length ? Math.max(...prices) : null,
    avg30: last30.length ? Math.round((last30.reduce((a, b) => a + b, 0) / last30.length) * 100) / 100 : null,
    points: history.length, daysTracked: Math.round(daysTracked * 10) / 10, claimedDiscount, realDiscount: null,
    isLowest: false, inflatedMrp: false, score: null, verdict: "collecting", summary: "",
    ...extras(history, nowMs),
  };
  if (current === null) return { ...base, summary: "No current price yet." };

  // Judge against the last 90 days when there is enough data there, otherwise against all history.
  const useRecent = recent.length >= 3;
  const window = useRecent ? recent : prices;
  const span = useRecent ? "90 days" : `${Math.round(daysTracked)} days`;
  if (window.length < 3 || daysTracked < 2) {
    const guess = claimedDiscount !== null ? Math.round(Math.min(claimedDiscount, 80) * 0.6) : null;
    return {
      ...base, score: guess,
      summary: claimedDiscount !== null
        ? `The store claims ${claimedDiscount}% off. Scaper needs a few days of its own price history to confirm it.`
        : "Collecting price history. A verdict appears after a few days of checks.",
    };
  }

  const low = Math.min(...window);
  const high = Math.max(...window);
  const typical = median(window);
  const realDiscount = typical > current ? Math.round(((typical - current) / typical) * 1000) / 10 : 0;
  const position = high > low ? (high - current) / (high - low) : 0.5; // 1 = at the low
  const isLowest = current <= low;
  const inflatedMrp = claimedDiscount !== null && listPrice !== null && listPrice > high * 1.25 && claimedDiscount - realDiscount > 20;
  const score = Math.round(Math.max(0, Math.min(100, position * 60 + Math.min(realDiscount, 40))));
  const verdict = isLowest && realDiscount >= 5 ? "great" : score >= 70 ? "great" : score >= 50 ? "good" : score >= 30 ? "fair" : "wait";
  const parts = [
    isLowest ? `Lowest price Scaper has seen in ${span}.` : `${useRecent ? "90-day" : `${span}`} range ${low.toLocaleString("en-IN")}–${high.toLocaleString("en-IN")}.`,
    realDiscount > 0 ? `${realDiscount}% below its usual price.` : "Not below its usual price.",
  ];
  if (inflatedMrp) parts.push(`The ${claimedDiscount}% "off M.R.P." looks inflated.`);
  return { ...base, low, high, realDiscount, isLowest, inflatedMrp, score, verdict, summary: parts.join(" ") };
}

import "server-only";
import { db } from "../db";

/** Firecrawl use per day: calls and the credits they cost, so your AI and you can keep credits in check. */

export type FirecrawlKind = "scrape" | "map" | "search";
const today = () => new Date().toISOString().slice(0, 10);

export function recordFirecrawl(kind: FirecrawlKind, credits: number) {
  db().prepare(`INSERT INTO firecrawl_usage (day, kind, calls, credits) VALUES (?, ?, 1, ?)
    ON CONFLICT (day, kind) DO UPDATE SET calls = calls + 1, credits = credits + excluded.credits`).run(today(), kind, Math.max(0, Math.round(credits)));
}

export function creditsUsedToday() {
  return (db().prepare("SELECT COALESCE(SUM(credits), 0) AS n FROM firecrawl_usage WHERE day = ?").get(today()) as { n: number }).n;
}

/** Today, the last 30 days, and today's calls by kind. */
export function firecrawlUsage() {
  const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const rows = db().prepare("SELECT kind, calls, credits FROM firecrawl_usage WHERE day = ?").all(today()) as { kind: FirecrawlKind; calls: number; credits: number }[];
  const month = db().prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(credits), 0) AS credits FROM firecrawl_usage WHERE day >= ?").get(since) as { calls: number; credits: number };
  return {
    today: { calls: rows.reduce((a, r) => a + r.calls, 0), credits: rows.reduce((a, r) => a + r.credits, 0), byKind: Object.fromEntries(rows.map((r) => [r.kind, { calls: r.calls, credits: r.credits }])) },
    last30Days: month,
  };
}

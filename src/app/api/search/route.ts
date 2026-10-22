import { handler } from "@/server/api";
import { listProducts } from "@/server/repo/products";
import { listRecipes } from "@/server/repo/scrapes";
import { listWatchers } from "@/server/repo/watchers";
import { listDealSearches } from "@/server/repo/deal-searches";

export const dynamic = "force-dynamic";

/** Command palette search across tasks, watchers, products and deal searches. */
export const GET = handler(async (req) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return { results: [] };
  const has = (...xs: (string | null | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(q));
  const results = [
    ...listRecipes().filter((t) => has(t.name, t.url, t.description)).slice(0, 6).map((t) => ({ type: "task", id: t.id, title: t.name, subtitle: t.url, href: `/tasks/${t.id}` })),
    ...listWatchers().filter((w) => has(w.name, w.url, ...w.tags)).slice(0, 6).map((w) => ({ type: "watcher", id: w.id, title: w.name, subtitle: w.url, href: `/watchers/${w.id}` })),
    ...listProducts().filter((p) => has(p.title, p.url, ...p.tags)).slice(0, 6).map((p) => ({ type: "product", id: p.id, title: p.title ?? p.url, subtitle: p.url, href: `/deals/${p.id}` })),
    ...listDealSearches().filter((d) => has(d.name, d.url)).slice(0, 4).map((d) => ({ type: "deal_search", id: d.id, title: d.name, subtitle: d.url, href: `/deals?tab=searches` })),
  ];
  return { results };
});

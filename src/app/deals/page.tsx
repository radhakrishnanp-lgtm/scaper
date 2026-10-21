"use client";

import { useState } from "react";
import Link from "next/link";
import { BadgePercent, Info, Plus, Search, Sparkles, Star, Tag } from "lucide-react";
import { ScoreBar, VerdictBadge, type DealStats, type ProductView } from "@/components/deal-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, LoadingRows, PageHeader, Segmented, Select, Switch } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { hostOf, money, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type ScanItem = {
  title: string; url: string; price: number | null; listPrice: number | null; discount: number | null; currency: string | null; rating: number | null;
  reviews: number | null; image: string | null; sponsored: boolean; tracked: boolean; stats: DealStats | null; aiNote?: string;
};

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  return src
    // eslint-disable-next-line @next/next/no-img-element -- product images come from many store CDNs
    ? <img src={src} alt={alt} loading="lazy" className="size-16 shrink-0 rounded-lg border border-border bg-white object-contain p-1" />
    : <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><Tag className="size-5" /></div>;
}

function Tracked() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi<{ products: ProductView[] }>("/api/products", { pollMs: 60_000 });
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [every, setEvery] = useState(360);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<"score" | "discount" | "recent">("score");

  const add = async () => {
    setBusy(true); setErrors({});
    try {
      const res = await api<{ created: boolean; product: ProductView; error?: string }>("/api/products", { body: { url, targetPrice: target ? Number(target) : null, intervalMinutes: every } });
      setData((d) => ({ products: [res.product, ...(d?.products ?? []).filter((p) => p.id !== res.product.id)] }));
      if (!res.created) toast.info("Already tracked", res.product.title ?? undefined);
      else if (res.error) toast.error("Added, but the first check failed", res.error);
      else toast.success("Tracking started", `${res.product.title?.slice(0, 60) ?? "Product"} at ${money(res.product.current_price, res.product.currency)}`);
      setUrl(""); setTarget("");
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not add product", errorText(e));
    } finally { setBusy(false); }
  };

  const products = [...(data?.products ?? [])].sort((a, b) =>
    sort === "score" ? (b.stats.score ?? -1) - (a.stats.score ?? -1)
      : sort === "discount" ? (b.stats.realDiscount ?? b.stats.claimedDiscount ?? 0) - (a.stats.realDiscount ?? a.stats.claimedDiscount ?? 0)
        : b.created_at.localeCompare(a.created_at));

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="grid gap-4 p-5 md:grid-cols-[1fr_160px_160px_auto] md:items-end">
          <Field label="Product URL" error={errors.url} hint="Amazon or any shop that shows a price.">
            {(p) => <Input {...p} type="url" required placeholder="https://www.amazon.in/dp/B0XXXXXXXX" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label="Alert at or below" error={errors.targetPrice}>{(p) => <Input {...p} type="number" min="0" step="any" placeholder="Optional" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
          <Field label="Check">{(p) => (
            <Select {...p} value={every} onChange={(e) => setEvery(Number(e.target.value))}>
              <option value={60}>Every hour</option><option value={180}>Every 3 h</option><option value={360}>Every 6 h</option><option value={720}>Every 12 h</option><option value={1440}>Daily</option>
            </Select>
          )}</Field>
          <Button type="submit" loading={busy} icon={<Plus className="size-4" />} className="md:mb-[22px]">Track</Button>
        </form>
      </Card>

      <Card>
        <CardHeader title="Tracked products" description="Deal score compares today's price with Scaper's own price history, not the shop's M.R.P."
          actions={<Select aria-label="Sort products" className="h-9 w-40" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="score">Best deal first</option><option value="discount">Biggest discount</option><option value="recent">Recently added</option></Select>} />
        {error ? <ErrorNote message={error} onRetry={reload} /> : loading && !data ? <LoadingRows /> : !products.length ? (
          <EmptyState icon={<Tag className="size-5" />} title="No products tracked">Paste a product link above. Scaper checks it on a schedule and builds a price history, so you can tell a real deal from a fake &quot;70% off&quot;.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {products.map((p) => (
              <li key={p.id}>
                <Link href={`/deals/${p.id}`} className="flex gap-4 px-5 py-4 hover:bg-surface-2/50">
                  <Thumb src={p.image} alt="" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium">{p.title ?? hostOf(p.url)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="font-semibold tabular-nums">{money(p.current_price, p.currency)}</span>
                      {p.list_price && <span className="text-muted line-through tabular-nums">{money(p.list_price, p.currency)}</span>}
                      {p.stats.claimedDiscount !== null && <Badge tone={p.stats.inflatedMrp ? "warning" : "neutral"}>{p.stats.claimedDiscount}% off M.R.P.</Badge>}
                      <VerdictBadge stats={p.stats} />
                      {p.in_stock === false && <Badge tone="danger">Out of stock</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-muted">{p.last_error ? <span className="text-warning">{p.last_error}</span> : `${p.stats.summary} · checked ${timeAgo(p.last_checked_at)}`}</p>
                    <div className="mt-2 max-w-xs"><ScoreBar score={p.stats.verdict === "collecting" ? null : p.stats.score} /></div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Finder() {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [minDiscount, setMinDiscount] = useState("20");
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ items: ScanItem[]; total: number; title: string; notes: string[] } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tracking, setTracking] = useState<string | null>(null);

  const scan = async () => {
    setBusy(true); setScanError(null);
    try {
      setResult(await api("/api/deals/scan", { body: { url, minDiscount: Number(minDiscount) || 0, rankWithAi: ai } }));
    } catch (e) { setScanError(errorText(e)); } finally { setBusy(false); }
  };

  const track = async (item: ScanItem) => {
    setTracking(item.url);
    try {
      await api("/api/products", { body: { url: item.url, intervalMinutes: 360 } });
      toast.success("Tracking started", item.title.slice(0, 70));
      setResult((r) => r && { ...r, items: r.items.map((i) => (i.url === item.url ? { ...i, tracked: true } : i)) });
    } catch (e) { toast.error("Could not track", errorText(e)); } finally { setTracking(null); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void scan(); }} className="space-y-4 p-5">
          <div className="grid gap-4 md:grid-cols-[1fr_160px]">
            <Field label="Listing page URL" hint="An Amazon search, category or deals page, or any shop's category page.">
              {(p) => <Input {...p} type="url" required placeholder="https://www.amazon.in/s?k=wireless+earbuds" value={url} onChange={(e) => setUrl(e.target.value)} />}
            </Field>
            <Field label="Min. discount %">{(p) => <Input {...p} type="number" min="0" max="95" value={minDiscount} onChange={(e) => setMinDiscount(e.target.value)} />}</Field>
          </div>
          <Switch checked={ai} onChange={setAi} label="Rank with my fast AI model" description="The model reads prices, discounts, ratings and review counts and picks the real deals. One AI call per scan." />
          <Button type="submit" loading={busy} icon={<Search className="size-4" />}>{busy ? "Scanning…" : "Find deals"}</Button>
        </form>
      </Card>
      {scanError && <Card><ErrorNote title="Scan failed" message={scanError} onRetry={scan} /></Card>}
      {busy && <Card><LoadingRows rows={5} /></Card>}
      {result && !busy && (
        <Card>
          <CardHeader title={`${result.items.length} deals`} description={`${result.total} items found on ${result.title || hostOf(url)}. Sorted by deal score, then discount.`} />
          {result.notes.length > 0 && <ul className="border-b border-border bg-surface-2/40 px-5 py-2 text-xs text-muted">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {!result.items.length ? (
            <EmptyState icon={<BadgePercent className="size-5" />} title="Nothing matched">Lower the minimum discount, or try a different listing page.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {result.items.map((i) => (
                <li key={i.url} className="flex gap-4 px-5 py-4">
                  <Thumb src={i.image} alt="" />
                  <div className="min-w-0 flex-1">
                    <a href={i.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-sm font-medium hover:text-accent">{i.title}</a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="font-semibold tabular-nums">{money(i.price, i.currency)}</span>
                      {i.listPrice && <span className="text-muted line-through tabular-nums">{money(i.listPrice, i.currency)}</span>}
                      {i.discount !== null && <Badge tone="success">{i.discount}% off</Badge>}
                      {i.rating !== null && <span className="inline-flex items-center gap-1 text-xs text-muted"><Star className="size-3.5" />{i.rating}{i.reviews !== null && ` (${i.reviews.toLocaleString("en-IN")})`}</span>}
                      {i.sponsored && <Badge>Sponsored</Badge>}
                      {i.stats && <VerdictBadge stats={i.stats} />}
                    </div>
                    {i.aiNote && <p className="mt-1.5 flex gap-1.5 text-xs text-accent"><Sparkles className="mt-px size-3.5 shrink-0" />{i.aiNote}</p>}
                  </div>
                  <Button size="sm" variant={i.tracked ? "ghost" : "secondary"} disabled={i.tracked} loading={tracking === i.url} onClick={() => track(i)} className="shrink-0 self-center">
                    {i.tracked ? "Tracked" : "Track"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

export default function DealsPage() {
  const [tab, setTab] = useState<"tracked" | "find">("tracked");
  return (
    <>
      <PageHeader title="Deals" description="Track prices and find real discounts, judged by price history." actions={
        <Segmented label="Deals view" value={tab} onChange={setTab} options={[{ value: "tracked", label: "Tracked", icon: <Tag className="size-4" /> }, { value: "find", label: "Find deals", icon: <BadgePercent className="size-4" /> }]} />
      } />
      <div className="mb-6 flex gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <p>Scaper loads shop pages slowly, one at a time per site, like a careful person would. It stops and tells you if a shop shows a robot check instead of trying to get around it. For large-scale Amazon data, Amazon&apos;s official Creators API (the successor to PA-API) is the reliable route.</p>
      </div>
      {tab === "tracked" ? <Tracked /> : <Finder />}
    </>
  );
}

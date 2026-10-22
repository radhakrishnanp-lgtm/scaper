"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BadgePercent, BookmarkPlus, Info, ListPlus, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Search, Sparkles, Star, Tag, Trash2 } from "lucide-react";
import type { DealSearch } from "@/server/repo/deal-searches";
import { atTarget, ScoreBar, Thumb, VerdictBadge, type ProductView, type ScanItem } from "@/components/deal-bits";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Menu } from "@/components/menu";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, Field, FilterChips, IconButton, Input, LoadingRows, PageHeader, SearchInput, Select, Stat, Switch, Tabs, TagInput, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { hostOf, interval, money, plural, timeAgo } from "@/lib/format";
import { dealFiltersSchema, type DealFilters } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type View = "tracked" | "find" | "searches";
type Show = "all" | "great" | "target" | "out" | "errors" | "paused";
type SavedSearch = Omit<DealSearch, "seen" | "last_result"> & { seen: number; last_result: ScanItem[] | null };

const EVERY = [60, 180, 360, 720, 1440];

function TrackedTab() {
  const toast = useToast();
  const params = useSearchParams();
  const { data, error, loading, reload } = useApi<{ products: ProductView[]; tags: string[]; groups: string[] }>("/api/products");
  const [url, setUrl] = useState(params.get("track") ?? "");
  const [target, setTarget] = useState("");
  const [every, setEvery] = useState(360);
  const [tags, setTags] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [show, setShow] = useQueryState<Show>("show", "all");
  const [tag, setTag] = useQueryState<string>("tag", "");
  const [group, setGroup] = useQueryState<string>("group", "");
  const [sort, setSort] = useState<"score" | "discount" | "price" | "recent" | "checked">("score");
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<ProductView | null>(null);

  const products = useMemo(() => data?.products ?? [], [data]);
  const counts = useMemo(() => ({
    all: products.length, great: products.filter((p) => p.stats.verdict === "great" || p.stats.verdict === "good").length,
    target: products.filter(atTarget).length, out: products.filter((p) => p.in_stock === false).length,
    errors: products.filter((p) => p.last_error).length, paused: products.filter((p) => !p.enabled).length,
  }), [products]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = products.filter((p) => {
      if (show === "great" && !(p.stats.verdict === "great" || p.stats.verdict === "good")) return false;
      if (show === "target" && !atTarget(p)) return false;
      if (show === "out" && p.in_stock !== false) return false;
      if (show === "errors" && !p.last_error) return false;
      if (show === "paused" && p.enabled) return false;
      if (tag && !p.tags.includes(tag)) return false;
      if (group && p.group_name !== group) return false;
      return !needle || `${p.title ?? ""} ${p.url} ${p.tags.join(" ")}`.toLowerCase().includes(needle);
    });
    return list.sort((a, b) =>
      sort === "score" ? (b.stats.score ?? -1) - (a.stats.score ?? -1)
        : sort === "discount" ? (b.stats.realDiscount ?? -100) - (a.stats.realDiscount ?? -100)
          : sort === "price" ? (a.current_price ?? Infinity) - (b.current_price ?? Infinity)
            : sort === "checked" ? (b.last_checked_at ?? "").localeCompare(a.last_checked_at ?? "")
              : b.created_at.localeCompare(a.created_at));
  }, [products, show, tag, group, q, sort]);

  const add = async () => {
    setBusy("add"); setErrors({});
    try {
      if (bulk) {
        const urls = bulkText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const r = await api<{ count: number }>("/api/products", { body: { urls, intervalMinutes: every, tags } });
        toast.success(`Adding ${r.count} products`, "Each one is checked in turn; this page fills in as they finish.");
        setBulkText("");
      } else {
        const res = await api<{ created: boolean; product: ProductView; error?: string }>("/api/products", { body: { url, targetPrice: target ? Number(target) : null, intervalMinutes: every, tags } });
        if (!res.created) toast.info("Already tracked", res.product.title ?? undefined);
        else if (res.error) toast.error("Added, but the first check failed", res.error);
        else toast.success("Tracking started", `${res.product.title?.slice(0, 60) ?? "Product"} at ${money(res.product.current_price, res.product.currency)}`);
        setUrl(""); setTarget("");
      }
      void reload();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not add", errorText(e));
    } finally { setBusy(null); }
  };
  const refresh = async (p: ProductView) => {
    setBusy(p.id);
    try {
      const r = await api<{ ok: boolean; error?: string; product: ProductView }>(`/api/products/${p.id}/refresh`, { method: "POST" });
      if (r.ok) toast.success("Price updated", `${money(r.product.current_price, r.product.currency)} · ${r.product.stats.summary}`);
      else toast.error("Check failed", r.error);
      void reload();
    } catch (e) { toast.error("Could not check", errorText(e)); } finally { setBusy(null); }
  };
  const patch = async (p: ProductView, body: Record<string, unknown>, ok: string) => {
    try { await api(`/api/products/${p.id}`, { method: "PATCH", body }); toast.success(ok); void reload(); } catch (e) { toast.error("Could not save", errorText(e)); }
  };
  const remove = async (p: ProductView) => {
    setBusy("delete");
    try { await api(`/api/products/${p.id}`, { method: "DELETE" }); toast.success("Stopped tracking", p.title ?? undefined); setConfirm(null); void reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{bulk ? "Track many products" : "Track a product"}</p>
            <Button type="button" size="sm" variant="ghost" icon={<ListPlus className="size-4" />} onClick={() => setBulk(!bulk)}>{bulk ? "Just one" : "Add many"}</Button>
          </div>
          {bulk ? (
            <Field label="Product URLs" hint="One per line, up to 200. They are checked one after another, politely.">
              {(p) => <Textarea {...p} rows={5} className="font-mono text-xs" value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={"https://www.amazon.in/dp/B0XXXXXXX1\nhttps://www.flipkart.com/…"} />}
            </Field>
          ) : (
            <div className="grid gap-4 md:grid-cols-[1fr_170px]">
              <Field label="Product URL" error={errors.url} hint="Amazon, Flipkart or any shop page that shows a price.">
                {(p) => <Input {...p} inputMode="url" required placeholder="https://www.amazon.in/dp/B0XXXXXXXX" value={url} onChange={(e) => setUrl(e.target.value)} />}
              </Field>
              <Field label="Alert at or below" error={errors.targetPrice}>{(p) => <Input {...p} type="number" min="0" step="any" placeholder="Optional" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-[170px_1fr_auto] md:items-end">
            <Field label="Check every">{(p) => <Select {...p} value={every} onChange={(e) => setEvery(Number(e.target.value))}>{EVERY.map((m) => <option key={m} value={m}>{interval(m)}</option>)}</Select>}</Field>
            <Field label="Tags">{(p) => <TagInput id={p.id} value={tags} onChange={setTags} suggestions={data?.tags ?? []} />}</Field>
            <Button type="submit" loading={busy === "add"} icon={<Plus className="size-4" />} disabled={bulk ? !bulkText.trim() : !url.trim()}>Track</Button>
          </div>
        </form>
      </Card>

      {products.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Tracked" value={counts.all} hint={counts.paused ? `${counts.paused} paused` : undefined} />
          <Stat label="Good or great now" value={counts.great} />
          <Stat label="At your target" value={counts.target} />
          <Stat label="Out of stock" value={counts.out} hint={counts.errors ? `${counts.errors} failing checks` : undefined} />
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 xl:flex-row xl:items-center xl:justify-between">
          <FilterChips label="Show" value={show} onChange={setShow} options={[
            { value: "all", label: "All", count: counts.all }, { value: "great", label: "Good deals", count: counts.great }, { value: "target", label: "At target", count: counts.target },
            { value: "out", label: "Out of stock", count: counts.out }, { value: "errors", label: "Failing", count: counts.errors }, { value: "paused", label: "Paused", count: counts.paused },
          ]} />
          <div className="flex flex-wrap gap-2">
            {Boolean(data?.tags.length) && <Select aria-label="Tag" className="h-10 w-36" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{data!.tags.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}
            {Boolean(data?.groups.length) && <Select aria-label="Group" className="h-10 w-40" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All groups</option>{data!.groups.map((g) => <option key={g} value={g}>{g}</option>)}</Select>}
            <Select aria-label="Sort" className="h-10 w-44" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="score">Best deal first</option><option value="discount">Biggest real discount</option><option value="price">Lowest price</option><option value="checked">Recently checked</option><option value="recent">Recently added</option>
            </Select>
            <SearchInput value={q} onChange={setQ} placeholder="Search products" className="w-full sm:w-52" />
          </div>
        </div>
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows /> : !products.length ? (
          <EmptyState icon={<Tag className="size-5" />} title="No products tracked">Paste a product link above. Scaper checks it on a schedule and builds a price history, so you can tell a real deal from a fake “70% off”.</EmptyState>
        ) : !shown.length ? <p className="px-5 py-10 text-center text-sm text-muted">No products match these filters.</p> : (
          <ul className="divide-y divide-border">
            {shown.map((p) => (
              <li key={p.id} className="flex gap-4 px-5 py-4 hover:bg-surface-2/40">
                <Thumb src={p.image} alt="" />
                <div className="min-w-0 flex-1">
                  <Link href={`/deals/${p.id}`} className="line-clamp-2 text-sm font-medium hover:text-accent">{p.title ?? hostOf(p.url)}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-semibold tabular-nums">{money(p.current_price, p.currency)}</span>
                    {p.list_price && p.list_price > (p.current_price ?? 0) && <span className="text-muted line-through tabular-nums">{money(p.list_price, p.currency)}</span>}
                    <VerdictBadge stats={p.stats} />
                    {p.stats.realDiscount !== null && p.stats.realDiscount > 0 && <Badge tone="success">{p.stats.realDiscount}% below usual</Badge>}
                    {p.stats.inflatedMrp && <Badge tone="warning">M.R.P. looks inflated</Badge>}
                    {atTarget(p) && <Badge tone="success">at target</Badge>}
                    {p.in_stock === false && <Badge tone="danger">Out of stock</Badge>}
                    {!p.enabled && <Badge>paused</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-muted">
                    {p.last_error ? <span className="text-warning">{p.last_error}</span> : <>{p.stats.summary}{p.stats.low !== null && ` · low ${money(p.stats.low, p.currency)}`}{p.stats.avg30 !== null && ` · 30-day avg ${money(p.stats.avg30, p.currency)}`} · {hostOf(p.url)} · checked {timeAgo(p.last_checked_at)}</>}
                  </p>
                  <div className="mt-2 max-w-xs"><ScoreBar score={p.stats.verdict === "collecting" ? null : p.stats.score} /></div>
                </div>
                <div className="flex shrink-0 items-start gap-1">
                  <IconButton size="sm" label="Check price now" disabled={busy === p.id} onClick={() => void refresh(p)}><RefreshCw className={busy === p.id ? "size-4 animate-spin" : "size-4"} /></IconButton>
                  <Menu label="Product actions" trigger={(t) => <IconButton {...t} size="sm" label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
                    { label: "Details & alerts", icon: <Pencil />, href: `/deals/${p.id}` },
                    { label: p.enabled ? "Pause checks" : "Resume checks", icon: p.enabled ? <Pause /> : <Play />, onSelect: () => void patch(p, { enabled: !p.enabled }, p.enabled ? "Paused" : "Resumed") },
                    { label: "Open in shop", href: p.url, external: true },
                    { label: "Price history CSV", href: `/api/products/${p.id}/export`, download: true },
                    { separator: true as const },
                    { label: "Stop tracking", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(p) },
                  ]} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void remove(confirm)} busy={busy === "delete"} title="Stop tracking this product?" body="Its price history is deleted too. Export it first if you want to keep it." />
    </div>
  );
}

function FiltersEditor({ value, onChange }: { value: DealFilters; onChange: (f: DealFilters) => void }) {
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Field label="Min. discount %">{(p) => <Input {...p} type="number" min={0} max={95} value={value.minDiscount} onChange={(e) => onChange({ ...value, minDiscount: Number(e.target.value) || 0 })} />}</Field>
      <Field label="Max. price">{(p) => <Input {...p} type="number" min={0} step="any" placeholder="Any" value={value.maxPrice ?? ""} onChange={(e) => onChange({ ...value, maxPrice: num(e.target.value) })} />}</Field>
      <Field label="Min. rating">{(p) => <Select {...p} value={value.minRating ?? ""} onChange={(e) => onChange({ ...value, minRating: num(e.target.value) })}><option value="">Any</option>{[3, 3.5, 4, 4.3, 4.5].map((r) => <option key={r} value={r}>{r}★ and up</option>)}</Select>}</Field>
      <Field label="Min. reviews">{(p) => <Input {...p} type="number" min={0} placeholder="Any" value={value.minReviews ?? ""} onChange={(e) => onChange({ ...value, minReviews: num(e.target.value) })} />}</Field>
      <Field label="Title must include" className="md:col-span-2" hint="Comma-separated; any of them.">{(p) => <Input {...p} value={value.include} onChange={(e) => onChange({ ...value, include: e.target.value })} placeholder="anc, bluetooth 5.3" />}</Field>
      <Field label="Title must not include" className="md:col-span-2">{(p) => <Input {...p} value={value.exclude} onChange={(e) => onChange({ ...value, exclude: e.target.value })} placeholder="refurbished, renewed" />}</Field>
      <div className="md:col-span-4"><Switch label="Hide sponsored results" checked={value.hideSponsored} onChange={(v) => onChange({ ...value, hideSponsored: v })} /></div>
    </div>
  );
}

function ScanResults({ items, onTrack, tracking }: { items: ScanItem[]; onTrack: (i: ScanItem) => void; tracking: string | null }) {
  if (!items.length) return <EmptyState icon={<BadgePercent className="size-5" />} title="Nothing matched">Loosen the filters, or try another listing page.</EmptyState>;
  return (
    <ul className="divide-y divide-border">
      {items.map((i) => (
        <li key={i.url} className="flex gap-4 px-5 py-4">
          <Thumb src={i.image} alt="" />
          <div className="min-w-0 flex-1">
            <a href={i.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-sm font-medium hover:text-accent">{i.title}</a>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold tabular-nums">{money(i.price, i.currency)}</span>
              {i.listPrice && <span className="text-muted line-through tabular-nums">{money(i.listPrice, i.currency)}</span>}
              {i.discount !== null && <Badge tone="success">{Math.round(i.discount)}% off</Badge>}
              {i.rating !== null && <span className="inline-flex items-center gap-1 text-xs text-muted"><Star className="size-3.5" />{i.rating}{i.reviews !== null && ` (${i.reviews.toLocaleString("en-IN")})`}</span>}
              {i.sponsored && <Badge>Sponsored</Badge>}
              {i.stats && <VerdictBadge stats={i.stats} />}
            </div>
            {i.aiNote && <p className="mt-1.5 flex gap-1.5 text-xs text-accent"><Sparkles className="mt-px size-3.5 shrink-0" />{i.aiNote}</p>}
          </div>
          <Button size="sm" variant={i.tracked ? "ghost" : "secondary"} disabled={i.tracked} loading={tracking === i.url} onClick={() => onTrack(i)} className="shrink-0 self-center">{i.tracked ? "Tracked" : "Track"}</Button>
        </li>
      ))}
    </ul>
  );
}

function FindTab() {
  const toast = useToast();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [filters, setFilters] = useState<DealFilters>({ ...dealFiltersSchema.parse({}), minDiscount: 20 });
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ items: ScanItem[]; total: number; title: string; notes: string[] } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tracking, setTracking] = useState<string | null>(null);
  const [sort, setSort] = useState<"score" | "discount" | "price" | "rating">("score");
  const [saveOpen, setSaveOpen] = useState(false);

  const scan = async () => {
    setBusy(true); setScanError(null);
    try { setResult(await api("/api/deals/scan", { body: { url, minDiscount: filters.minDiscount, rankWithAi: ai, filters } })); }
    catch (e) { setScanError(errorText(e)); } finally { setBusy(false); }
  };
  const track = async (item: ScanItem) => {
    setTracking(item.url);
    try {
      await api("/api/products", { body: { url: item.url, intervalMinutes: 360 } });
      toast.success("Tracking started", item.title.slice(0, 70));
      setResult((r) => r && { ...r, items: r.items.map((i) => (i.url === item.url ? { ...i, tracked: true } : i)) });
    } catch (e) { toast.error("Could not track", errorText(e)); } finally { setTracking(null); }
  };
  const sorted = useMemo(() => [...(result?.items ?? [])].sort((a, b) =>
    sort === "discount" ? (b.discount ?? 0) - (a.discount ?? 0) : sort === "price" ? (a.price ?? Infinity) - (b.price ?? Infinity)
      : sort === "rating" ? (b.rating ?? 0) - (a.rating ?? 0) : 0), [result, sort]);

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void scan(); }} className="space-y-4 p-5">
          <Field label="Listing page URL" hint="An Amazon search, category or deals page, or any shop's category page.">
            {(p) => <Input {...p} inputMode="url" required placeholder="https://www.amazon.in/s?k=wireless+earbuds" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <FiltersEditor value={filters} onChange={setFilters} />
          <Switch checked={ai} onChange={setAi} label="Rank with my fast AI model" description="The model reads prices, discounts, ratings and review counts and picks the real deals. One AI call per scan." />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy} icon={<Search className="size-4" />}>{busy ? "Scanning…" : "Find deals"}</Button>
            <Button type="button" variant="secondary" icon={<BookmarkPlus className="size-4" />} disabled={!url.trim()} onClick={() => setSaveOpen(true)}>Save as a search</Button>
          </div>
        </form>
      </Card>
      {scanError && <Card><ErrorNote title="Scan failed" message={scanError} onRetry={scan} /></Card>}
      {busy && <Card><LoadingRows rows={5} /></Card>}
      {result && !busy && (
        <Card>
          <CardHeader title={plural(result.items.length, "deal")} description={`${plural(result.total, "item")} found on ${result.title || hostOf(url)}.`}
            actions={<Select aria-label="Sort" className="h-9 w-44" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="score">Scaper&apos;s order</option><option value="discount">Biggest discount</option><option value="price">Lowest price</option><option value="rating">Best rated</option></Select>} />
          {result.notes.length > 0 && <ul className="border-b border-border bg-surface-2/40 px-5 py-2 text-xs text-muted">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <ScanResults items={sorted} onTrack={track} tracking={tracking} />
        </Card>
      )}
      <SearchDialog open={saveOpen} onClose={() => setSaveOpen(false)} initial={{ name: result?.title?.slice(0, 80) || (url ? hostOf(url) : ""), url, filters, rankWithAi: ai }} onSaved={() => router.push("/deals?tab=searches")} />
    </div>
  );
}

type SearchDraft = { id?: string; name: string; url: string; filters: DealFilters; rankWithAi: boolean; scheduleMinutes?: number | null; notifyNew?: boolean };

function SearchDialog({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial: SearchDraft; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<SearchDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) { setLastOpen(open); if (open) { setD(initial); setErrors({}); } }
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const body = { name: d.name, url: d.url, filters: d.filters, rankWithAi: d.rankWithAi, scheduleMinutes: d.scheduleMinutes ?? 360, notifyNew: d.notifyNew ?? true };
      await api(d.id ? `/api/deals/searches/${d.id}` : "/api/deals/searches", { method: d.id ? "PUT" : "POST", body });
      toast.success(d.id ? "Search saved" : "Search saved", "It runs on schedule and alerts you about new deals.");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} wide title={d.id ? "Edit deal search" : "Save as a deal search"} description="Scaper re-scans the page on a schedule and alerts you only about deals it hasn't shown you before."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name}>{(p) => <Input {...p} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
          <Field label="Run">{(p) => (
            <Select {...p} value={d.scheduleMinutes ?? 360} onChange={(e) => setD({ ...d, scheduleMinutes: e.target.value === "0" ? null : Number(e.target.value) })}>
              <option value="0">Only when I press Run</option>{[60, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>Every {interval(m)}</option>)}
            </Select>
          )}</Field>
        </div>
        <Field label="Listing URL" error={errors.url}>{(p) => <Input {...p} value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} />}</Field>
        <FiltersEditor value={d.filters} onChange={(f) => setD({ ...d, filters: f })} />
        <div className="flex flex-wrap gap-6">
          <Switch label="Alert me about new deals" checked={d.notifyNew ?? true} onChange={(v) => setD({ ...d, notifyNew: v })} />
          <Switch label="Rank with AI" checked={d.rankWithAi} onChange={(v) => setD({ ...d, rankWithAi: v })} />
        </div>
      </div>
    </Dialog>
  );
}

function SearchesTab() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ searches: SavedSearch[] }>("/api/deals/searches");
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<SearchDraft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SavedSearch | null>(null);
  const [tracking, setTracking] = useState<string | null>(null);

  const run = async (s: SavedSearch) => {
    setBusy(s.id);
    try {
      const r = await api<{ job: { status: string; error: string | null; result: { total?: number; fresh?: number } | null } }>(`/api/deals/searches/${s.id}/run`, { method: "POST" });
      if (r.job.status === "succeeded") toast.success("Search finished", `${r.job.result?.total ?? 0} deals, ${r.job.result?.fresh ?? 0} new`);
      else toast.error("Search failed", r.job.error ?? undefined);
      setOpen(s.id); void reload();
    } catch (e) { toast.error("Could not run", errorText(e)); } finally { setBusy(null); }
  };
  const remove = async (s: SavedSearch) => {
    setBusy("delete");
    try { await api(`/api/deals/searches/${s.id}`, { method: "DELETE" }); toast.success("Search deleted"); setConfirm(null); void reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); } finally { setBusy(null); }
  };
  const track = async (item: ScanItem) => {
    setTracking(item.url);
    try { await api("/api/products", { body: { url: item.url, intervalMinutes: 360 } }); toast.success("Tracking started", item.title.slice(0, 70)); }
    catch (e) { toast.error("Could not track", errorText(e)); } finally { setTracking(null); }
  };

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Card><LoadingRows /></Card>;
  const searches = data?.searches ?? [];
  return (
    <div className="space-y-4">
      {!searches.length ? (
        <Card><EmptyState icon={<BookmarkPlus className="size-5" />} title="No saved searches" action={<Link href="/deals?tab=find"><Button>Find deals</Button></Link>}>Scan a listing page on the Find deals tab, then save it. Scaper re-checks it and alerts you about new deals only.</EmptyState></Card>
      ) : searches.map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="font-medium">{s.name}</p>
              <p className="truncate text-xs text-muted">{hostOf(s.url)} · {s.schedule_minutes ? `every ${interval(s.schedule_minutes)}` : "manual"} · {s.filters.minDiscount}%+ off{s.filters.maxPrice ? ` · under ${s.filters.maxPrice}` : ""}{s.filters.minRating ? ` · ${s.filters.minRating}★+` : ""}{s.rank_with_ai ? " · AI ranked" : ""}</p>
              <p className="mt-1 text-xs text-muted">{s.last_run_at ? <>Last run {timeAgo(s.last_run_at)} · {s.last_status === "error" ? <span className="text-danger">failed</span> : `${s.last_count ?? 0} deals`} · {s.seen} seen so far</> : "Not run yet"}</p>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy === s.id} onClick={() => void run(s)}>Run</Button>
              {s.last_result?.length ? <Button size="sm" variant="ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide" : `Show ${s.last_result.length}`}</Button> : null}
              <Menu label="Search actions" trigger={(t) => <IconButton {...t} size="sm" label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
                { label: "Edit", icon: <Pencil />, onSelect: () => setEdit({ id: s.id, name: s.name, url: s.url, filters: s.filters, rankWithAi: s.rank_with_ai, scheduleMinutes: s.schedule_minutes, notifyNew: s.notify_new }) },
                { label: "Open listing", href: s.url, external: true },
                { separator: true as const },
                { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(s) },
              ]} />
            </div>
          </div>
          {open === s.id && s.last_result && <div className="border-t border-border"><ScanResults items={s.last_result} onTrack={track} tracking={tracking} /></div>}
        </Card>
      ))}
      {edit && <SearchDialog open onClose={() => setEdit(null)} initial={edit} onSaved={() => void reload()} />}
      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void remove(confirm)} busy={busy === "delete"} title="Delete this search?" body="Products you already track are not affected." />
    </div>
  );
}

function DealsPage() {
  const [view, setView] = useQueryState<View>("tab", "tracked");
  return (
    <>
      <PageHeader title="Prices & deals" description="Track prices, judge discounts against real price history, and get told about new deals." />
      <Tabs value={view} onChange={setView} className="mb-6" tabs={[
        { value: "tracked", label: "Tracked products", icon: <Tag className="size-4" /> },
        { value: "find", label: "Find deals", icon: <BadgePercent className="size-4" /> },
        { value: "searches", label: "Saved searches", icon: <BookmarkPlus className="size-4" /> },
      ]} />
      {view === "tracked" && <TrackedTab />}
      {view === "find" && <FindTab />}
      {view === "searches" && <SearchesTab />}
      <div className="mt-8"><Callout icon={<Info className="size-4 text-accent" />} title="How Scaper treats shops">It loads shop pages slowly, one at a time per site, like a careful person would, and stops if a shop shows a robot check instead of trying to get around it. For large-scale Amazon data, Amazon&apos;s official Creators API is the reliable route.</Callout></div>
    </>
  );
}

export default function Page() {
  return <Suspense><DealsPage /></Suspense>;
}

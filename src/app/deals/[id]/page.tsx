"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, MoreHorizontal, Pause, Play, RefreshCw, Save, Star, Trash2 } from "lucide-react";
import type { PricePoint } from "@/server/repo/products";
import { PriceChart } from "@/components/charts";
import { atTarget, ScoreBar, Thumb, VerdictBadge, type ProductView } from "@/components/deal-bits";
import { ConfirmDialog } from "@/components/dialog";
import { ChannelPicker } from "@/components/form-bits";
import { Menu } from "@/components/menu";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, ErrorNote, Field, IconButton, Input, KeyValue, LoadingRows, Select, Switch, TagInput, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime, hostOf, interval, money, plural, timeAgo } from "@/lib/format";
import type { NotifyChannels, ProductAlerts } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

type Detail = { product: ProductView; history: PricePoint[]; siblings: ProductView[] };
const DEFAULT_CHANNELS: NotifyChannels = { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false };

function Settings({ p, onSaved }: { p: ProductView; onSaved: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState(p.target_price?.toString() ?? "");
  const [minutes, setMinutes] = useState(p.interval_minutes);
  const [alerts, setAlerts] = useState<ProductAlerts>(p.alerts);
  const [tags, setTags] = useState(p.tags);
  const [group, setGroup] = useState(p.group_name);
  const [notes, setNotes] = useState(p.notes);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/products/${p.id}`, { method: "PATCH", body: { targetPrice: target ? Number(target) : null, intervalMinutes: minutes, alerts, tags, groupName: group, notes } });
      toast.success("Saved");
      onSaved();
    } catch (e) { toast.error("Could not save", errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Alerts & settings" actions={<Button size="sm" icon={<Save className="size-4" />} loading={busy} onClick={save}>Save</Button>} />
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Alert at or below" hint={p.currency ?? undefined}>{(f) => <Input {...f} type="number" min={0} step="any" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="No target" />}</Field>
          <Field label="Check every">{(f) => <Select {...f} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[...new Set([60, 180, 360, 720, 1440, minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{interval(m)}</option>)}</Select>}</Field>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch label="Alert on a drop of" checked={alerts.dropPercent !== null} onChange={(v) => setAlerts({ ...alerts, dropPercent: v ? 10 : null })} />
            {alerts.dropPercent !== null && <><Input aria-label="Drop percent" type="number" min={1} max={95} className="h-9 w-20" value={alerts.dropPercent} onChange={(e) => setAlerts({ ...alerts, dropPercent: Number(e.target.value) || 1 })} /><span className="text-sm text-muted">% or more</span></>}
          </div>
          <Switch label="Alert on a new lowest price" description="After at least three checks." checked={alerts.newLow} onChange={(v) => setAlerts({ ...alerts, newLow: v })} />
          <Switch label="Alert when back in stock" checked={alerts.backInStock} onChange={(v) => setAlerts({ ...alerts, backInStock: v })} />
        </div>
        <div className="space-y-2">
          <Switch label="Use my default alert channels" description="Every channel set up in Settings → Alerts." checked={alerts.channels === null} onChange={(v) => setAlerts({ ...alerts, channels: v ? null : DEFAULT_CHANNELS })} />
          {alerts.channels && <ChannelPicker value={alerts.channels} onChange={(c) => setAlerts({ ...alerts, channels: c })} />}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tags">{(f) => <TagInput id={f.id} value={tags} onChange={setTags} />}</Field>
          <Field label="Compare group" hint="Give the same item at other shops the same group name to compare them.">{(f) => <Input {...f} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Sony WH-1000XM5" />}</Field>
        </div>
        <Field label="Notes">{(f) => <Textarea {...f} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      </div>
    </Card>
  );
}

function ProductDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<Detail>(`/api/products/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showTable, setShowTable] = useState(false);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Card><LoadingRows rows={6} /></Card>;
  const p = data.product;
  const s = p.stats;
  const fmt = (v: number | null | undefined) => money(v ?? null, p.currency);

  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await api<{ ok: boolean; error?: string; product: ProductView }>(`/api/products/${id}/refresh`, { method: "POST" });
      if (r.ok) toast.success("Price updated", `${fmt(r.product.current_price)} · ${r.product.stats.summary}`); else toast.error("Check failed", r.error);
      void reload();
    } catch (e) { toast.error("Could not check", errorText(e)); } finally { setBusy(null); }
  };
  const toggle = async () => {
    try { await api(`/api/products/${id}`, { method: "PATCH", body: { enabled: !p.enabled } }); toast.success(p.enabled ? "Paused" : "Resumed"); void reload(); }
    catch (e) { toast.error("Could not update", errorText(e)); }
  };
  const remove = async () => {
    setBusy("delete");
    try { await api(`/api/products/${id}`, { method: "DELETE" }); toast.success("Stopped tracking"); router.push("/deals"); }
    catch (e) { toast.error("Could not delete", errorText(e)); setBusy(null); }
  };

  const stat = (label: string, value: React.ReactNode, hint?: React.ReactNode) => ({ label, value: <span>{value}{hint && <span className="ml-1.5 text-xs text-muted">{hint}</span>}</span> });

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Link href="/deals" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Prices & deals</Link>
        <div className="flex gap-2">
          <Button icon={<RefreshCw className="size-4" />} loading={busy === "refresh"} onClick={refresh}>Check now</Button>
          <Menu label="Product actions" trigger={(t) => <IconButton {...t} label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: p.enabled ? "Pause checks" : "Resume checks", icon: p.enabled ? <Pause /> : <Play />, onSelect: () => void toggle() },
            { label: "Price history CSV", icon: <Download />, href: `/api/products/${id}/export`, download: true },
            { label: "Open in shop", icon: <ExternalLink />, href: p.url, external: true },
            { separator: true as const },
            { label: "Stop tracking", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
          ]} />
        </div>
      </div>

      <div className="space-y-6">
        <Card className="flex flex-col gap-5 p-5 sm:flex-row">
          <Thumb src={p.image} alt={p.title ?? "Product"} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{p.title ?? hostOf(p.url)}</h1>
            <a href={p.url} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex items-center gap-1 text-sm text-accent hover:underline">{hostOf(p.url)}<ExternalLink className="size-3" /></a>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">{fmt(p.current_price)}</span>
              {p.list_price && p.list_price > (p.current_price ?? 0) && <span className="text-muted line-through tabular-nums">{fmt(p.list_price)}</span>}
              <VerdictBadge stats={s} />
              {atTarget(p) && <Badge tone="success">at your target</Badge>}
              {p.in_stock === false && <Badge tone="danger">Out of stock</Badge>}
              {p.in_stock === true && <Badge tone="success">In stock</Badge>}
              {!p.enabled && <Badge>paused</Badge>}
            </div>
            <p className="mt-2 text-sm text-muted">{s.summary}</p>
            <div className="mt-3 max-w-sm"><ScoreBar score={s.verdict === "collecting" ? null : s.score} /></div>
            <p className="mt-3 flex flex-wrap items-center gap-x-3 text-xs text-muted">
              {p.rating !== null && <span className="inline-flex items-center gap-1"><Star className="size-3.5" />{p.rating}{p.review_count !== null && ` (${p.review_count.toLocaleString("en-IN")} reviews)`}</span>}
              <span>checked {timeAgo(p.last_checked_at)}, every {interval(p.interval_minutes)}</span>
              {p.enabled && p.next_check_at && <span>next {timeAgo(p.next_check_at)}</span>}
            </p>
          </div>
        </Card>

        {p.last_error && <Callout tone="warning" title="The last check failed">{p.last_error}</Callout>}
        {s.inflatedMrp && <Callout tone="warning" title="The shop's M.R.P. looks inflated">The claimed {Math.round(s.claimedDiscount ?? 0)}% off is measured from a list price this item has not actually sold at. Judge it by the history below instead.</Callout>}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <Card>
              <CardHeader title="Price history" description={s.daysTracked >= 1 ? `${plural(s.points, "check")} over ${plural(s.daysTracked, "day")}` : `${plural(s.points, "check")} so far`} actions={<a href={`/api/products/${id}/export`} download><Button size="sm" variant="ghost" icon={<Download className="size-4" />}>CSV</Button></a>} />
              <div className="p-4">
                <PriceChart points={data.history.map((h) => ({ t: h.created_at, v: h.price }))} format={(v) => money(v, p.currency)} target={p.target_price} />
              </div>
              <div className="border-t border-border px-4 py-2">
                <button type="button" className="text-sm text-accent hover:underline" onClick={() => setShowTable(!showTable)}>{showTable ? "Hide" : "Show"} every check</button>
              </div>
              {showTable && (
                <div className="scroll-thin max-h-80 overflow-auto border-t border-border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">When</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="px-3 py-2 text-right font-medium">List price</th><th className="px-3 py-2 font-medium">Stock</th></tr></thead>
                    <tbody className="divide-y divide-border">
                      {[...data.history].reverse().map((h, i) => (
                        <tr key={i}><td className="px-4 py-1.5">{dateTime(h.created_at)}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmt(h.price)}</td><td className="px-3 py-1.5 text-right text-muted tabular-nums">{h.list_price ? fmt(h.list_price) : "—"}</td><td className="px-3 py-1.5">{h.in_stock === null ? "—" : h.in_stock ? "in stock" : <span className="text-danger">out</span>}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {data.siblings.length > 0 && (
              <Card>
                <CardHeader title={`Same item at other shops · ${p.group_name}`} description="Cheapest first." />
                <ul className="divide-y divide-border">
                  {data.siblings.map((x) => (
                    <li key={x.id}>
                      <Link href={`/deals/${x.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/40">
                        <span className="min-w-0 flex-1 truncate text-sm">{hostOf(x.url)} · {x.title}</span>
                        <span className="font-semibold tabular-nums">{money(x.current_price, x.currency)}</span>
                        <VerdictBadge stats={x.stats} />
                        {x.current_price !== null && p.current_price !== null && <Badge tone={x.current_price < p.current_price ? "success" : "neutral"}>{x.current_price < p.current_price ? `${money(p.current_price - x.current_price, p.currency)} cheaper` : x.current_price === p.current_price ? "same" : "dearer"}</Badge>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Settings key={p.updated_at} p={p} onSaved={() => void reload()} />
          </div>

          <Card className="h-fit p-5">
            <p className="mb-3 text-sm font-semibold">Price statistics</p>
            <KeyValue items={[
              stat("Now", fmt(s.current)),
              stat("Lowest ever", fmt(s.allTimeLow?.price ?? s.low), s.allTimeLow ? dateTime(s.allTimeLow.at).split(",")[0] : undefined),
              stat("Highest ever", fmt(s.allTimeHigh?.price ?? s.high), s.allTimeHigh ? dateTime(s.allTimeHigh.at).split(",")[0] : undefined),
              stat("30-day average", fmt(s.avg30)),
              { ...stat("90-day average", fmt(s.avg90)), hidden: s.avg90 === null },
              { ...stat("180-day average", fmt(s.avg180)), hidden: s.avg180 === null },
              { ...stat("1-year average", fmt(s.avg365)), hidden: s.avg365 === null },
              stat("Real discount", s.realDiscount !== null ? `${s.realDiscount}%` : "—", "vs usual price"),
              stat("Shop's discount", s.claimedDiscount !== null ? `${Math.round(s.claimedDiscount)}%` : "—", s.inflatedMrp ? "inflated" : "off M.R.P."),
              stat("Price drops", s.drops),
              stat("Last change", s.lastChange ? `${fmt(s.lastChange.from)} → ${fmt(s.lastChange.to)}` : "—", s.lastChange ? timeAgo(s.lastChange.at) : undefined),
              { ...stat("Out of stock", `${s.outOfStockPercent}% of checks`), hidden: s.outOfStockPercent === null },
              stat("Lowest right now", s.isLowest ? "Yes" : "No"),
            ]} />
            <p className="mt-4 text-xs text-muted">Averages and lows come only from Scaper&apos;s own checks, so they get more reliable the longer an item is tracked.</p>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={remove} busy={busy === "delete"} title="Stop tracking this product?" body="Its price history is deleted too. Download the CSV first if you want to keep it." />
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><ProductDetail id={id} /></Suspense>;
}

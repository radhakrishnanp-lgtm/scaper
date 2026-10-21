"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw, Star, Trash2 } from "lucide-react";
import { PriceChart } from "@/components/charts";
import { ScoreBar, VerdictBadge, type ProductView } from "@/components/deal-bits";
import { ConfirmDialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, LoadingRows, Select, Stat, Switch } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { hostOf, money, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<{ product: ProductView; history: { price: number; created_at: string }[] }>(`/api/products/${id}`);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [target, setTarget] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Card><LoadingRows /></Card>;
  const p = data.product;
  const s = p.stats;
  const fmt = (v: number) => money(v, p.currency);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    try { await api(`/api/products/${id}`, { method: "PATCH", body }); toast.success(ok); void reload(); }
    catch (e) { toast.error("Could not save", errorText(e)); }
  };

  return (
    <>
      <Link href="/deals" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Deals</Link>
      <div className="mb-6 flex flex-col gap-5 sm:flex-row">
        {p.image && (
          // eslint-disable-next-line @next/next/no-img-element -- product image from the store's CDN
          <img src={p.image} alt="" className="size-32 shrink-0 rounded-xl border border-border bg-white object-contain p-2" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{p.title ?? hostOf(p.url)}</h1>
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-sm text-accent hover:underline">{hostOf(p.url)}<ExternalLink className="size-3.5" /></a>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums">{money(p.current_price, p.currency)}</span>
            {p.list_price && <span className="text-muted line-through tabular-nums">{money(p.list_price, p.currency)}</span>}
            <VerdictBadge stats={s} />
            {p.in_stock === false && <Badge tone="danger">Out of stock</Badge>}
            {p.rating !== null && <span className="inline-flex items-center gap-1 text-sm text-muted"><Star className="size-4" />{p.rating}{p.review_count !== null && ` · ${p.review_count.toLocaleString("en-IN")} ratings`}</span>}
          </div>
          <p className="mt-2 text-sm text-muted">{s.summary}</p>
          <div className="mt-2 max-w-sm"><ScoreBar score={s.verdict === "collecting" ? null : s.score} /></div>
        </div>
        <div className="flex shrink-0 gap-2 sm:flex-col">
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={refreshing} onClick={async () => {
            setRefreshing(true);
            try {
              const r = await api<{ ok: boolean; error?: string }>(`/api/products/${id}/refresh`, { body: {} });
              if (r.ok) toast.success("Price updated"); else toast.error("Check failed", r.error);
              void reload();
            } catch (e) { toast.error("Check failed", errorText(e)); } finally { setRefreshing(false); }
          }}>Check now</Button>
          <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Stop tracking</Button>
        </div>
      </div>

      {p.last_error && <div role="alert" className="mb-6 rounded-xl border border-warning/30 bg-warning-soft/50 p-4 text-sm"><span className="font-medium">Last check failed: </span>{p.last_error}</div>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Lowest seen" value={s.low !== null ? fmt(s.low) : "—"} hint={s.isLowest ? "That's today" : undefined} />
        <Stat label="Highest seen" value={s.high !== null ? fmt(s.high) : "—"} />
        <Stat label="30-day average" value={s.avg30 !== null ? fmt(s.avg30) : "—"} />
        <Stat label="Real discount" value={s.realDiscount !== null ? `${s.realDiscount}%` : "—"} hint={s.claimedDiscount !== null ? `Shop claims ${s.claimedDiscount}%${s.inflatedMrp ? " (looks inflated)" : ""}` : "vs. its usual price"} />
      </div>

      <Card className="mt-6">
        <CardHeader title="Price history" description={`${s.points} checks over ${s.daysTracked} days. Scaper records a price on every check.`} />
        <div className="p-5"><PriceChart points={data.history.map((h) => ({ t: h.created_at, v: h.price }))} format={fmt} /></div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Tracking" description={`Last check ${timeAgo(p.last_checked_at)}${p.enabled ? `, next ${timeAgo(p.next_check_at)}` : ""}.`} />
        <div className="grid gap-5 p-5 md:grid-cols-3 md:items-end">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void patch({ targetPrice: target ? Number(target) : null }, "Target saved"); }}>
            <Field label="Alert at or below" className="flex-1">{(f) => <Input {...f} type="number" step="any" min="0" placeholder="No target" value={target ?? (p.target_price?.toString() ?? "")} onChange={(e) => setTarget(e.target.value)} />}</Field>
            <Button type="submit" variant="secondary">Save</Button>
          </form>
          <Field label="Check">{(f) => (
            <Select {...f} value={p.interval_minutes} onChange={(e) => patch({ intervalMinutes: Number(e.target.value) }, "Schedule saved")}>
              {[...new Set([60, 180, 360, 720, 1440, p.interval_minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m < 1440 ? `Every ${m / 60} h` : "Daily"}</option>)}
            </Select>
          )}</Field>
          <Switch checked={p.enabled} onChange={(v) => patch({ enabled: v }, v ? "Tracking resumed" : "Tracking paused")} label="Tracking on" description="Alerts on a new 90-day low or your target." />
        </div>
      </Card>

      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} title="Stop tracking?" body="The product and its whole price history will be deleted. This can't be undone." confirmLabel="Stop and delete"
        onConfirm={async () => {
          try { await api(`/api/products/${id}`, { method: "DELETE" }); toast.success("Stopped tracking"); router.push("/deals"); }
          catch (e) { toast.error("Could not delete", errorText(e)); setDeleting(false); }
        }} />
    </>
  );
}

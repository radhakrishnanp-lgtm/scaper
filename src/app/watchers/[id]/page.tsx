"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, GitCompare, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { PriceChart } from "@/components/charts";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, LoadingRows, Stat, Switch } from "@/components/ui";
import { conditionText, WatcherDialog, type WatcherView } from "@/components/watcher-form";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, interval, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Snap = { id: string; value: number | null; changed: boolean; triggered: boolean; created_at: string; diff: { added: number; removed: number; patch: { op: "+" | "-" | " "; text: string }[] } | null };

export default function WatcherDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const w = useApi<{ watcher: WatcherView; series: { value: number; created_at: string }[] }>(`/api/watchers/${id}`);
  const [changedOnly, setChangedOnly] = useState(true);
  const snaps = useApi<{ items: Snap[]; nextCursor: string | null }>(`/api/watchers/${id}/snapshots?changed=${changedOnly ? 1 : 0}&limit=50`);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<{ id: string; content: string } | null>(null);

  if (w.error) return <ErrorNote message={w.error} onRetry={w.reload} />;
  if (!w.data) return <Card><LoadingRows /></Card>;
  const watcher = w.data.watcher;
  const sel = snaps.data?.items.find((s) => s.id === selected) ?? snaps.data?.items.find((s) => s.diff) ?? null;

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = await api<{ outcome: { status: string; message: string } }>(`/api/watchers/${id}/check`, { body: {} });
      (res.outcome.status === "ok" ? toast.success : toast.error)("Check finished", res.outcome.message);
      void w.reload(); void snaps.reload();
    } catch (e) { toast.error("Check failed", errorText(e)); } finally { setChecking(false); }
  };

  const showContent = async (sid: string) => {
    try {
      const res = await api<{ snapshot: { id: string; content: string } }>(`/api/watchers/${id}/snapshots/${sid}`);
      setPreview(res.snapshot);
    } catch (e) { toast.error("Could not load snapshot", errorText(e)); }
  };

  return (
    <>
      <Link href="/watchers" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Watchers</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h1 className="truncate text-2xl font-semibold tracking-tight">{watcher.name}</h1><StatusBadge status={watcher.last_status} enabled={watcher.enabled} failCount={watcher.fail_count} /></div>
          <a href={watcher.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-sm text-accent hover:underline">{watcher.url}<ExternalLink className="size-3.5 shrink-0" /></a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={checking} onClick={checkNow}>Check now</Button>
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="secondary" icon={watcher.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
            onClick={async () => { await api(`/api/watchers/${id}`, { method: "PATCH", body: { enabled: !watcher.enabled } }).catch((e) => toast.error("Could not update", errorText(e))); void w.reload(); }}>
            {watcher.enabled ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" aria-label="Delete watcher" onClick={() => setDeleting(true)}><Trash2 className="size-4" /></Button>
        </div>
      </div>

      {watcher.last_error && watcher.last_status !== "ok" && (
        <div role="alert" className="mb-6 rounded-xl border border-warning/30 bg-warning-soft/50 p-4 text-sm"><span className="font-medium">Last check failed{watcher.fail_count > 1 ? ` (${watcher.fail_count} times in a row)` : ""}: </span>{watcher.last_error}</div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Rule" value={<span className="text-base">{conditionText(watcher.condition)}</span>} hint={`Every ${interval(watcher.interval_minutes)}`} />
        <Stat label="Changes" value={watcher.change_count} hint={`${watcher.check_count} checks`} />
        <Stat label="Last check" value={<span className="text-base">{timeAgo(watcher.last_checked_at)}</span>} hint={watcher.enabled ? `Next ${timeAgo(watcher.next_check_at)}` : "Paused"} />
        <Stat label="Current value" value={watcher.last_value !== null ? watcher.last_value.toLocaleString("en-IN") : "—"} hint={watcher.target.type === "page" ? "Whole page" : watcher.target.type === "price" ? "Price" : "Selector"} />
      </div>

      {w.data.series.length > 1 && (
        <Card className="mt-6">
          <CardHeader title="Value over time" />
          <div className="p-5"><PriceChart points={w.data.series.map((s) => ({ t: s.created_at, v: s.value }))} format={(v) => v.toLocaleString("en-IN")} /></div>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <CardHeader title="History" actions={<Switch checked={changedOnly} onChange={setChangedOnly} label="Changes only" />} />
          {snaps.loading && !snaps.data ? <LoadingRows rows={3} /> : !snaps.data?.items.length ? (
            <p className="px-5 py-6 text-sm text-muted">{changedOnly ? "No changes detected yet." : "No checks yet."} {watcher.check_count === 0 && "The first check saves a baseline."}</p>
          ) : (
            <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
              {snaps.data.items.map((s) => (
                <li key={s.id}>
                  <button onClick={() => setSelected(s.id)} className={cn("flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/50", sel?.id === s.id && "bg-accent-soft/40")}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{dateTime(s.created_at)}</p>
                      <p className="text-xs text-muted">{s.diff ? `+${s.diff.added} / −${s.diff.removed} lines` : s.changed ? "Changed" : "Baseline / no change"}{s.value !== null && ` · ${s.value.toLocaleString("en-IN")}`}</p>
                    </div>
                    {s.triggered && <Badge tone="accent">alert</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="min-w-0">
          <CardHeader title="What changed" description={sel ? dateTime(sel.created_at) : undefined} actions={sel && <Button size="sm" variant="secondary" onClick={() => showContent(sel.id)}>View full snapshot</Button>} />
          {!sel?.diff ? (
            <EmptyState icon={<GitCompare className="size-5" />} title="No change to show yet">When the watched content changes, the added and removed lines appear here.</EmptyState>
          ) : (
            <pre className="max-h-[560px] overflow-auto p-4 font-mono text-xs leading-relaxed">
              {sel.diff.patch.map((p, i) => (
                <div key={i} className={cn("rounded px-2 whitespace-pre-wrap", p.op === "+" && "bg-success-soft/70 text-success", p.op === "-" && "bg-danger-soft/70 text-danger line-through decoration-danger/40", p.op === " " && "text-muted")}>
                  <span className="mr-2 select-none" aria-hidden>{p.op}</span>{p.text}
                  <span className="sr-only">{p.op === "+" ? " (added)" : p.op === "-" ? " (removed)" : ""}</span>
                </div>
              ))}
            </pre>
          )}
        </Card>
      </div>

      <WatcherDialog open={editing} initial={watcher} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void w.reload(); void snaps.reload(); }} />
      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} title="Delete watcher?" body="This deletes the watcher and all of its history. This can't be undone."
        onConfirm={async () => {
          try { await api(`/api/watchers/${id}`, { method: "DELETE" }); toast.success("Watcher deleted"); router.push("/watchers"); }
          catch (e) { toast.error("Could not delete", errorText(e)); setDeleting(false); }
        }} />
      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} title="Snapshot content" wide>
        <pre className="font-mono text-xs whitespace-pre-wrap">{preview?.content}</pre>
      </Dialog>
    </>
  );
}

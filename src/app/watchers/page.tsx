"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Pause, Play, Plus, Radar, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Button, Card, EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui";
import { conditionText, WatcherDialog, type WatcherView } from "@/components/watcher-form";
import { api, errorText } from "@/lib/api-client";
import { hostOf, interval, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

function WatchersPage() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi<{ watchers: WatcherView[] }>("/api/watchers", { pollMs: 20_000 });
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WatcherView | null>(null);

  const prefill = params.get("new") ? { url: params.get("url") ?? "", name: params.get("name") ?? "" } : undefined;
  useEffect(() => {
    // Open the form when arriving from "Watch page" on a scrape result.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (params.get("new")) setCreating(true);
  }, [params]);

  const toggle = async (w: WatcherView) => {
    try {
      const res = await api<{ watcher: WatcherView }>(`/api/watchers/${w.id}`, { method: "PATCH", body: { enabled: !w.enabled } });
      setData((d) => d && { watchers: d.watchers.map((x) => (x.id === w.id ? res.watcher : x)) });
      toast.success(w.enabled ? "Watcher paused" : "Watcher resumed");
    } catch (e) { toast.error("Could not update", errorText(e)); }
  };

  const checkNow = async (w: WatcherView) => {
    setChecking(w.id);
    try {
      const res = await api<{ outcome: { status: string; message: string }; watcher: WatcherView }>(`/api/watchers/${w.id}/check`, { body: {} });
      setData((d) => d && { watchers: d.watchers.map((x) => (x.id === w.id ? res.watcher : x)) });
      if (res.outcome.status === "ok") toast.success(w.name, res.outcome.message);
      else toast.error(w.name, res.outcome.message);
    } catch (e) { toast.error("Check failed", errorText(e)); } finally { setChecking(null); }
  };

  return (
    <>
      <PageHeader title="Watchers" description="Pages Scaper checks on a schedule. You get an alert when your rule matches."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New watcher</Button>} />
      <Card>
        {error ? <ErrorNote message={error} onRetry={reload} /> : loading && !data ? <LoadingRows /> : !data?.watchers.length ? (
          <EmptyState icon={<Radar className="size-5" />} title="No watchers yet" action={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create your first watcher</Button>}>
            Watch a job board for new posts, a product for a price drop, or a page for &quot;In stock&quot;.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.watchers.map((w) => (
              <li key={w.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <Link href={`/watchers/${w.id}`} className="min-w-0 flex-1 group">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium group-hover:text-accent">{w.name}</p>
                    <StatusBadge status={w.last_status} enabled={w.enabled} failCount={w.fail_count} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted">
                    {hostOf(w.url)} · {conditionText(w.condition)} · every {interval(w.interval_minutes)}
                    {w.last_value !== null && <> · now <span className="text-text tabular-nums">{w.last_value.toLocaleString("en-IN")}</span></>}
                  </p>
                  {w.last_error && w.last_status !== "ok" && <p className="mt-1 line-clamp-1 text-xs text-warning">{w.last_error}</p>}
                </Link>
                <div className="flex shrink-0 items-center gap-1 text-xs text-muted">
                  <span className="mr-2 hidden tabular-nums md:inline">checked {timeAgo(w.last_checked_at)} · {w.change_count} changes</span>
                  <Button size="sm" variant="ghost" aria-label={`Check ${w.name} now`} loading={checking === w.id} onClick={() => checkNow(w)}>{checking !== w.id && <RefreshCw className="size-4" />}</Button>
                  <Button size="sm" variant="ghost" aria-label={w.enabled ? `Pause ${w.name}` : `Resume ${w.name}`} onClick={() => toggle(w)}>{w.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${w.name}`} onClick={() => setDeleting(w)}><Trash2 className="size-4" /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <WatcherDialog open={creating} initial={prefill} onClose={() => { setCreating(false); if (params.get("new")) router.replace("/watchers"); }}
        onSaved={(w) => { setCreating(false); setData((d) => ({ watchers: [w, ...(d?.watchers ?? [])] })); router.replace("/watchers"); }} />

      <ConfirmDialog open={Boolean(deleting)} onCancel={() => setDeleting(null)} title="Delete watcher?"
        body={<>“{deleting?.name}” and its full change history will be deleted. This can&apos;t be undone. To stop it for now, pause it instead.</>}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api(`/api/watchers/${deleting.id}`, { method: "DELETE" });
            setData((d) => d && { watchers: d.watchers.filter((x) => x.id !== deleting.id) });
            toast.success("Watcher deleted");
          } catch (e) { toast.error("Could not delete", errorText(e)); }
          setDeleting(null);
        }} />
    </>
  );
}

export default function Page() {
  return <Suspense><WatchersPage /></Suspense>;
}

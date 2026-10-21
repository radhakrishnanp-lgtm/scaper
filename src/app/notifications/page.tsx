"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, BellRing, Bot, CheckCheck, ExternalLink, Tag } from "lucide-react";
import { useToast } from "@/components/toast";
import { Button, Card, EmptyState, ErrorNote, LoadingRows, PageHeader, Segmented } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type N = { id: string; kind: string; title: string; body: string; url: string | null; watcher_id: string | null; product_id: string | null; read_at: string | null; created_at: string };
type Page = { items: N[]; nextCursor: string | null; unread: number };

const ICON: Record<string, typeof Bell> = { watcher: Bell, price: Tag, agent: Bot, system: AlertTriangle };

export default function NotificationsPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { data, error, loading, reload, setData } = useApi<Page>(`/api/notifications?limit=50${filter === "unread" ? "&unread=1" : ""}`);
  const [perm, setPerm] = useState<string>("unsupported");
  useEffect(() => {
    // Browser-only API; read after mount to keep server and client HTML identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPerm("Notification" in window ? Notification.permission : "unsupported");
  }, []);
  const [more, setMore] = useState(false);

  const markAll = async () => {
    try { await api("/api/notifications", { body: { action: "read", ids: "all" } }); void reload(); window.dispatchEvent(new Event("scaper:live")); }
    catch (e) { toast.error("Could not update", errorText(e)); }
  };
  const markOne = async (n: N) => {
    if (n.read_at) return;
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) });
    await api("/api/notifications", { body: { action: "read", ids: [n.id] } }).catch(() => undefined);
  };

  return (
    <>
      <PageHeader title="Alerts" description="Everything your watchers, price trackers and agent told you."
        actions={<>
          <Segmented label="Filter" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread${data?.unread ? ` (${data.unread})` : ""}` }]} />
          <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={markAll} disabled={!data?.unread}>Mark all read</Button>
        </>} />

      {perm !== "granted" && perm !== "unsupported" && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
          <p className="flex items-center gap-2"><BellRing className="size-4 text-accent" />{perm === "denied" ? "Desktop notifications are blocked for this site. Allow them in your browser's site settings." : "Turn on desktop notifications to see alerts even when this tab is in the background."}</p>
          {perm === "default" && <Button size="sm" onClick={async () => setPerm(await Notification.requestPermission())}>Turn on</Button>}
        </div>
      )}

      <Card>
        {error ? <ErrorNote message={error} onRetry={reload} /> : loading && !data ? <LoadingRows /> : !data?.items.length ? (
          <EmptyState icon={<Bell className="size-5" />} title={filter === "unread" ? "You're all caught up" : "No alerts yet"}>Alerts from watchers and price trackers will appear here.</EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {data.items.map((n) => {
                const I = ICON[n.kind] ?? Bell;
                const internal = n.watcher_id ? `/watchers/${n.watcher_id}` : n.product_id ? `/deals/${n.product_id}` : null;
                return (
                  <li key={n.id} onMouseEnter={() => markOne(n)} onFocus={() => markOne(n)} className={cn("flex gap-3 px-5 py-4", !n.read_at && "bg-accent-soft/25")}>
                    <I className={cn("mt-0.5 size-4 shrink-0", n.kind === "system" ? "text-warning" : "text-accent")} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium">{!n.read_at && <span className="sr-only">Unread: </span>}{n.title}</p>
                        <time dateTime={n.created_at} title={dateTime(n.created_at)} className="shrink-0 text-xs text-muted">{timeAgo(n.created_at)}</time>
                      </div>
                      <p className="mt-1 text-sm break-words whitespace-pre-line text-muted">{n.body}</p>
                      <div className="mt-2 flex flex-wrap gap-4 text-sm">
                        {internal && <Link href={internal} className="font-medium text-accent hover:underline">Open in Scaper</Link>}
                        {n.url && <a href={n.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:text-text">Visit page <ExternalLink className="size-3.5" /></a>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {data.nextCursor && (
              <div className="border-t border-border p-3 text-center">
                <Button variant="ghost" loading={more} onClick={async () => {
                  setMore(true);
                  try {
                    const next = await api<Page>(`/api/notifications?limit=50&before=${encodeURIComponent(data.nextCursor!)}${filter === "unread" ? "&unread=1" : ""}`);
                    setData({ ...next, items: [...data.items, ...next.items] });
                  } catch (e) { toast.error("Could not load more", errorText(e)); } finally { setMore(false); }
                }}>Load more</Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

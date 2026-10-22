"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, BadgePercent, Bell, BellOff, Bot, CheckCheck, ExternalLink, ListChecks, Radar, Settings, Tag, Trash2 } from "lucide-react";
import type { Notification } from "@/server/repo/notifications";
import type { PublicSettings } from "@/server/repo/settings";
import { ConfirmDialog } from "@/components/dialog";
import { useLive } from "@/components/live";
import { useToast } from "@/components/toast";
import { Button, Callout, Card, Checkbox, EmptyState, ErrorNote, FilterChips, LoadingRows, PageHeader, SearchInput } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Page = { items: Notification[]; nextCursor: string | null; unread: number };
type Kind = "all" | "watcher" | "price" | "deal" | "task" | "agent" | "system";

const ICON: Record<string, React.ReactNode> = {
  watcher: <Radar className="size-4" />, price: <Tag className="size-4" />, deal: <BadgePercent className="size-4" />, task: <ListChecks className="size-4" />,
  agent: <Bot className="size-4" />, system: <AlertTriangle className="size-4" />,
};

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
}

function sourceHref(n: Notification) {
  if (n.watcher_id) return `/watchers/${n.watcher_id}`;
  if (n.product_id) return `/deals/${n.product_id}`;
  return null;
}

function Body({ text }: { text: string }) {
  return (
    <div className="mt-1 space-y-0.5 text-sm break-words text-muted">
      {text.split("\n").slice(0, 8).map((l, i) => (
        <p key={i} className={cn(l.startsWith("+ ") && "font-mono text-xs text-success", l.startsWith("- ") && "font-mono text-xs text-danger")}>{l || " "}</p>
      ))}
    </div>
  );
}

function AlertsPage() {
  const toast = useToast();
  const live = useLive();
  const [unreadOnly, setUnreadOnly] = useQueryState<"all" | "unread">("show", "all");
  const [kind, setKind] = useQueryState<Kind>("kind", "all");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<"read" | string[] | null>(null);
  const [perm, setPerm] = useState<string>("unsupported");
  const settings = useApi<{ settings: PublicSettings }>("/api/settings");

  useEffect(() => {
    // Browser-only API; read after mount so server and client HTML match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPerm("Notification" in window ? Notification.permission : "unsupported");
  }, []);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (unreadOnly === "unread") p.set("unread", "1");
    if (kind !== "all") p.set("kind", kind);
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [unreadOnly, kind, debounced]);
  const { data, error, loading, reload, setData } = useApi<Page>(`/api/notifications?${qs}`);
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setCursor(undefined); setSelected(new Set()); }

  const items = useMemo(() => [...(data?.items ?? []), ...extra], [data, extra]);
  const next = cursor === undefined ? data?.nextCursor ?? null : cursor;
  const groups = useMemo(() => {
    const m = new Map<string, Notification[]>();
    for (const n of items) { const k = dayLabel(n.created_at); m.set(k, [...(m.get(k) ?? []), n]); }
    return [...m.entries()];
  }, [items]);

  const post = async (body: unknown, ok?: string) => {
    try {
      const r = await api<{ unread: number }>("/api/notifications", { body });
      live.setUnread(r.unread);
      if (ok) toast.success(ok);
      setExtra([]); setCursor(undefined); setSelected(new Set());
      void reload();
    } catch (e) { toast.error("Could not update", errorText(e)); }
  };
  const markOne = async (n: Notification) => {
    if (n.read_at) return;
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) });
    const r = await api<{ unread: number }>("/api/notifications", { body: { action: "read", ids: [n.id] } }).catch(() => null);
    if (r) live.setUnread(r.unread);
  };
  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try { const page = await api<Page>(`/api/notifications?${qs}&before=${encodeURIComponent(next)}`); setExtra((e) => [...e, ...page.items]); setCursor(page.nextCursor); }
    catch (e) { toast.error("Could not load more", errorText(e)); } finally { setMore(false); }
  };
  const unmute = async () => {
    try { await api("/api/settings", { method: "PUT", body: { notifications: { muteAll: false } } }); toast.success("Alerts unmuted"); void settings.reload(); }
    catch (e) { toast.error("Could not update", errorText(e)); }
  };

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Everything Scaper told you about: changes, price drops, new deals, task results and problems."
        actions={<>
          {perm === "default" && <Button variant="secondary" icon={<Bell className="size-4" />} onClick={() => void Notification.requestPermission().then(setPerm)}>Enable desktop alerts</Button>}
          <Button variant="secondary" icon={<CheckCheck className="size-4" />} disabled={!data?.unread} onClick={() => void post({ action: "read", ids: "all" }, "All marked as read")}>Mark all read</Button>
          <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm("read")}>Delete read</Button>
          <Link prefetch={false} href="/settings?tab=alerts"><Button variant="ghost" icon={<Settings className="size-4" />}>Channels</Button></Link>
        </>}
      />

      {settings.data?.settings.notifications.muteAll && (
        <div className="mb-4"><Callout tone="warning" icon={<BellOff className="size-4 text-warning" />} title="External channels are muted" action={<Button size="sm" variant="secondary" onClick={unmute}>Unmute</Button>}>Alerts still arrive here, but Telegram, email, webhooks and the rest are paused.</Callout></div>
      )}
      {perm === "denied" && <div className="mb-4"><Callout tone="neutral" title="Desktop alerts are blocked in this browser">Allow notifications for this site in the browser&apos;s site settings to get pop-ups.</Callout></div>}

      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-3">
            <FilterChips label="Read state" value={unreadOnly} onChange={setUnreadOnly} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread", count: data?.unread }]} />
            <FilterChips label="Kind" value={kind} onChange={setKind} options={[
              { value: "all", label: "Every kind" }, { value: "watcher", label: "Watchers" }, { value: "price", label: "Prices" }, { value: "deal", label: "Deals" },
              { value: "task", label: "Tasks" }, { value: "agent", label: "Agent" }, { value: "system", label: "System" },
            ]} />
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="Search alerts" className="w-full xl:w-60" />
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 border-b border-border bg-accent-soft/30 px-4 py-2.5 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => void post({ action: "read", ids: [...selected] })}>Mark read</Button>
            <Button size="sm" variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm([...selected])}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={6} /> : items.length === 0 ? (
          <EmptyState icon={<Bell className="size-5" />} title={unreadOnly === "unread" ? "All caught up" : "No alerts"}>
            {unreadOnly === "unread" || kind !== "all" || debounced ? "Nothing matches these filters." : "When a watcher sees a change, a price drops or a task finds new rows, it shows up here."}
          </EmptyState>
        ) : groups.map(([day, list]) => (
          <section key={day}>
            <h2 className="sticky top-14 z-10 border-b border-border bg-surface-2/90 px-4 py-1.5 text-xs font-semibold text-muted backdrop-blur">{day}</h2>
            <ul className="divide-y divide-border">
              {list.map((n) => {
                const src = sourceHref(n);
                return (
                  <li key={n.id} className={cn("flex gap-3 px-4 py-3", !n.read_at && "bg-accent-soft/20")} onMouseEnter={() => void markOne(n)}>
                    <Checkbox hideLabel label="Select alert" className="mt-0.5 self-start" checked={selected.has(n.id)} onChange={(v) => { const s = new Set(selected); if (v) s.add(n.id); else s.delete(n.id); setSelected(s); }} />
                    <span className={cn("mt-0.5 shrink-0", n.read_at ? "text-muted" : "text-accent")}>{ICON[n.kind] ?? <Bell className="size-4" />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-x-3">
                        <p className={cn("text-sm", !n.read_at && "font-semibold")}>{n.title}</p>
                        <time className="shrink-0 text-xs text-muted" title={dateTime(n.created_at)}>{timeAgo(n.created_at)}</time>
                      </div>
                      <Body text={n.body} />
                      <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
                        {src && <Link prefetch={false} href={src} className="font-medium text-accent hover:underline">{n.watcher_id ? "See the change" : "Price history"}</Link>}
                        {n.url && <a href={n.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:text-text">Open page<ExternalLink className="size-3" /></a>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {next && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load more</Button></div>}
      </Card>

      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)}
        onConfirm={() => { const ids = confirm; setConfirm(null); void post({ action: "delete", ids }, "Deleted"); }}
        title={confirm === "read" ? "Delete all read alerts?" : `Delete ${Array.isArray(confirm) ? confirm.length : 0} alerts?`} body="This only clears the inbox. Watchers, snapshots and price history are kept." />
    </>
  );
}

export default function Page() {
  return <Suspense><AlertsPage /></Suspense>;
}

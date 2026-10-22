"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Bot, BrainCircuit, Database, History, Radar, Tag } from "lucide-react";
import type { TimelineItem, TimelineType } from "@/server/repo/history";
import { useToast } from "./toast";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, LoadingRows, SearchInput } from "./ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

const TYPES: { value: TimelineType; label: string; icon: React.ReactNode }[] = [
  { value: "scrape", label: "Scrapes", icon: <Database className="size-4" /> },
  { value: "agent", label: "Agent", icon: <Bot className="size-4" /> },
  { value: "change", label: "Page changes", icon: <Radar className="size-4" /> },
  { value: "price", label: "Price changes", icon: <Tag className="size-4" /> },
  { value: "alert", label: "Alerts", icon: <Bell className="size-4" /> },
  { value: "ai", label: "AI calls", icon: <BrainCircuit className="size-4" /> },
];
const ICON = Object.fromEntries(TYPES.map((t) => [t.value, t.icon])) as Record<TimelineType, React.ReactNode>;
const TONE: Record<string, "success" | "danger" | "warning" | "accent" | "neutral"> = {
  ok: "success", done: "success", down: "success", error: "danger", blocked: "danger", up: "warning", partial: "warning", triggered: "accent", unread: "accent", cached: "accent",
};

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

/** One feed of everything Scaper did, grouped by day. */
export function Timeline() {
  const toast = useToast();
  const [types, setTypes] = useState<TimelineType[]>(["scrape", "agent", "change", "price", "alert"]);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "60", types: types.join(",") });
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [types, debounced]);
  const { data, error, loading, reload } = useApi<{ items: TimelineItem[]; nextCursor: string | null }>(types.length ? `/api/history/timeline?${qs}` : null);
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setCursor(undefined); }
  const items = [...(data?.items ?? []), ...extra];
  const next = cursor === undefined ? data?.nextCursor ?? null : cursor;
  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try { const p = await api<{ items: TimelineItem[]; nextCursor: string | null }>(`/api/history/timeline?${qs}&before=${encodeURIComponent(next)}`); setExtra((e) => [...e, ...p.items]); setCursor(p.nextCursor); }
    catch (e) { toast.error("Could not load more", errorText(e)); } finally { setMore(false); }
  };
  const groups: { day: string; items: TimelineItem[] }[] = [];
  for (const it of items) {
    const day = dayLabel(it.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(it);
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {TYPES.map((t) => <Checkbox key={t.value} label={t.label} checked={types.includes(t.value)} onChange={(on) => setTypes((x) => (on ? [...x, t.value] : x.filter((y) => y !== t.value)))} />)}
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search everything" className="w-full lg:w-64" />
      </div>
      {!types.length ? <p className="p-4 text-sm text-muted">Choose at least one kind.</p>
        : error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div>
        : loading && !data ? <LoadingRows rows={8} />
        : !items.length ? <EmptyState icon={<History className="size-5" />} title="Nothing here">{debounced ? "Nothing matches." : "Scrapes, agent chats, changes and alerts show up here as they happen."}</EmptyState>
        : (
          <div className="divide-y divide-border">
            {groups.map((g) => (
              <section key={g.day}>
                <h3 className="sticky top-14 z-10 bg-surface/95 px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase backdrop-blur">{g.day}</h3>
                <ol>
                  {g.items.map((it) => (
                    <li key={`${it.type}-${it.id}`}>
                      <Link prefetch={false} href={it.href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2/50">
                        <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-muted", it.type === "agent" && "bg-accent-soft text-accent")}>{ICON[it.type]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{it.title}</span>
                          <span className="block truncate text-xs text-muted">{it.subtitle}</span>
                        </span>
                        {it.status && <Badge tone={TONE[it.status] ?? "neutral"}>{it.status}</Badge>}
                        <time className="w-20 shrink-0 text-right text-xs text-muted" title={dateTime(it.at)}>{timeAgo(it.at)}</time>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      {next && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load older</Button></div>}
    </Card>
  );
}

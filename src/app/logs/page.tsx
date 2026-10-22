"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, ScrollText } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorNote, FilterChips, LoadingRows, PageHeader, SearchInput, Switch } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Event = { id: number; level: "info" | "warn" | "error"; event: string; data: Record<string, unknown>; created_at: string };
type Level = "all" | "problems" | "info" | "warn" | "error";

const LINKS: Record<string, (v: string) => string> = {
  watcherId: (v) => `/watchers/${v}`, taskId: (v) => `/tasks/${v}`, recipeId: (v) => `/tasks/${v}`, productId: (v) => `/deals/${v}`, jobId: (v) => `/runs/${v}`, runId: (v) => `/history/${v}`,
};

function DataCell({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.slice(0, 8).map(([k, v]) => {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        const href = typeof v === "string" && LINKS[k] ? LINKS[k]!(v) : null;
        return (
          <span key={k} className="min-w-0 break-all">
            <span className="text-muted">{k}=</span>
            {href ? <Link href={href} className="text-accent hover:underline">{text.slice(0, 8)}</Link> : <span>{text.length > 160 ? `${text.slice(0, 160)}…` : text}</span>}
          </span>
        );
      })}
    </span>
  );
}

function LogsPage() {
  const [level, setLevel] = useQueryState<Level>("level", "all");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<Event[]>([]);
  const [done, setDone] = useState(false);
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "100" });
    if (level !== "all") p.set("level", level);
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [level, debounced]);
  const { data, error, loading, reload } = useApi<{ events: Event[] }>(`/api/events?${qs}`, { pollMs: follow ? 10_000 : undefined });
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setDone(false); }

  const events = [...(data?.events ?? []), ...extra];
  const loadMore = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    setMore(true); setMoreError(null);
    try {
      const page = await api<{ events: Event[] }>(`/api/events?${qs}&before=${last.id}`);
      setExtra((e) => [...e, ...page.events]);
      if (page.events.length < 100) setDone(true);
    } catch (e) { setMoreError(errorText(e)); } finally { setMore(false); }
  };
  const download = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(events, null, 2))}`;

  return (
    <>
      <PageHeader title="Logs" description="What Scaper did and why: saved settings, blocked pages, failed alerts, backups. Kept as long as Settings → Data says."
        actions={<a href={download} download={`scaper-logs-${new Date().toISOString().slice(0, 10)}.json`}><Button variant="secondary" icon={<Download className="size-4" />} disabled={!events.length}>Download shown</Button></a>} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Level" value={level} onChange={setLevel} options={[
            { value: "all", label: "All" }, { value: "problems", label: "Problems" }, { value: "error", label: "Errors" }, { value: "warn", label: "Warnings" }, { value: "info", label: "Info" },
          ]} />
          <div className="flex items-center gap-4">
            <Switch label="Live" checked={follow} onChange={setFollow} />
            <SearchInput value={q} onChange={setQ} placeholder="Search events" className="w-full lg:w-64" />
          </div>
        </div>
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={8} /> : !events.length ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="No events">{level !== "all" || debounced ? "Nothing matches these filters." : "Events appear as Scaper works."}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-muted">
                <tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-3 py-2.5 font-medium">Level</th><th className="px-3 py-2.5 font-medium">Event</th><th className="px-3 py-2.5 font-medium">Details</th></tr>
              </thead>
              <tbody className="divide-y divide-border font-mono text-xs">
                {events.map((e) => (
                  <tr key={e.id} className={cn(e.level === "error" && "bg-danger-soft/30", e.level === "warn" && "bg-warning-soft/30")}>
                    <td className="px-4 py-2 align-top font-sans whitespace-nowrap text-muted" title={dateTime(e.created_at)}>{timeAgo(e.created_at)}</td>
                    <td className="px-3 py-2 align-top font-sans"><Badge tone={e.level === "error" ? "danger" : e.level === "warn" ? "warning" : "neutral"}>{e.level}</Badge></td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">{e.event}</td>
                    <td className="px-3 py-2 align-top"><DataCell data={e.data} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <p className="px-4 pb-2 text-sm text-danger">{moreError}</p>}
        {events.length >= 100 && !done && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load older</Button></div>}
      </Card>
    </>
  );
}

export default function Page() {
  return <Suspense><LogsPage /></Suspense>;
}

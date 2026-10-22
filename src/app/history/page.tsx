"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Database, Download, EyeOff, History, List, MoreHorizontal, Trash2 } from "lucide-react";
import { Timeline } from "@/components/timeline";
import type { Task } from "@/server/repo/scrapes";
import { ConfirmDialog } from "@/components/dialog";
import { Menu } from "@/components/menu";
import type { RunView } from "@/components/scrape-result";
import { RunStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, FilterChips, IconButton, LoadingRows, PageHeader, SearchInput, Select, Tabs } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime, duration, hostOf, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type RunsPage = { items: RunView[]; nextCursor: string | null };
type Status = "all" | "ok" | "partial" | "error" | "blocked";

function DataPage() {
  const [view, setView] = useQueryState<"results" | "timeline">("view", "results");
  return (
    <>
      <PageHeader
        title="Data"
        description="The rows from every scrape and task run, and a timeline of everything Scaper did."
        actions={<a href="/api/data/export"><Button variant="secondary" icon={<Download className="size-4" />}>Back up everything (JSON)</Button></a>}
      />
      <Tabs className="mb-4" value={view} onChange={setView} tabs={[{ value: "results", label: "Results", icon: <List className="size-4" /> }, { value: "timeline", label: "Timeline", icon: <History className="size-4" /> }]} />
      {view === "timeline" ? <Timeline /> : <Results />}
    </>
  );
}

function Results() {
  const toast = useToast();
  const [status, setStatus] = useQueryState<Status>("status", "all");
  const [task, setTask] = useQueryState<string>("task", "");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<RunView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const tasks = useApi<{ tasks: Task[] }>("/api/tasks");

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "40" });
    if (status !== "all") p.set("status", status);
    if (task) p.set("recipeId", task);
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [status, task, debounced]);
  const { data, error, loading, reload } = useApi<RunsPage>(`/api/runs?${qs}`);
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setCursor(undefined); setSelected(new Set()); }

  const items = [...(data?.items ?? []), ...extra];
  const next = cursor === undefined ? data?.nextCursor ?? null : cursor;
  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const page = await api<RunsPage>(`/api/runs?${qs}&before=${encodeURIComponent(next)}`);
      setExtra((e) => [...e, ...page.items]); setCursor(page.nextCursor);
    } catch (e) { toast.error("Could not load more", errorText(e)); } finally { setMore(false); }
  };
  const remove = async (ids: string[]) => {
    setDeleting(true);
    try {
      const { removed } = await api<{ removed: number }>("/api/runs", { method: "DELETE", body: { ids } });
      toast.success(`${removed} result${removed === 1 ? "" : "s"} deleted`);
      setConfirm(null); setSelected(new Set()); setExtra((e) => e.filter((r) => !ids.includes(r.id)));
      void reload();
    } catch (e) { toast.error("Could not delete", errorText(e)); } finally { setDeleting(false); }
  };
  const allChecked = items.length > 0 && items.every((r) => selected.has(r.id));

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Status" value={status} onChange={setStatus} options={[
            { value: "all", label: "All" }, { value: "ok", label: "OK" }, { value: "partial", label: "Partial" }, { value: "error", label: "Failed" }, { value: "blocked", label: "Blocked" },
          ]} />
          <div className="flex gap-2">
            <Select aria-label="Task" className="h-10 w-48" value={task} onChange={(e) => setTask(e.target.value)}>
              <option value="">All sources</option>
              {tasks.data?.tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <SearchInput value={q} onChange={setQ} placeholder="Search URL or task" className="w-full lg:w-60" />
          </div>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 border-b border-border bg-accent-soft/30 px-4 py-2.5 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm([...selected])}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={6} /> : items.length === 0 ? (
          <EmptyState icon={<Database className="size-5" />} title="No data here" action={<Link prefetch={false} href="/scrape"><Button>Quick scrape</Button></Link>}>
            {status === "all" && !task && !debounced ? "Results from scrapes and tasks appear here." : "Try other filters."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-muted">
                <tr>
                  <th className="w-10 px-4 py-2.5"><Checkbox hideLabel label="Select all" checked={allChecked} indeterminate={selected.size > 0} onChange={(v) => setSelected(v ? new Set(items.map((r) => r.id)) : new Set())} /></th>
                  <th className="px-3 py-2.5 font-medium">Source</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Rows</th>
                  <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Pages</th>
                  <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Took</th>
                  <th className="px-3 py-2.5 font-medium">When</th>
                  <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-2/40">
                    <td className="px-4 py-3"><Checkbox hideLabel label="Select" checked={selected.has(r.id)} onChange={(v) => { const n = new Set(selected); if (v) n.add(r.id); else n.delete(r.id); setSelected(n); }} /></td>
                    <td className="max-w-sm px-3 py-3">
                      <Link prefetch={false} href={`/history/${r.id}`} className="block truncate font-medium hover:text-accent">{r.private && <Badge className="mr-1.5"><EyeOff className="size-3" />private</Badge>}{r.recipe_name ?? hostOf(r.url)}</Link>
                      <p className="truncate text-xs text-muted">{r.url}</p>
                      {r.error && <p className="truncate text-xs text-danger" title={r.error}>{r.error}</p>}
                    </td>
                    <td className="px-3 py-3"><RunStatusBadge status={r.status} /></td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.row_count.toLocaleString("en-IN")}</td>
                    <td className="hidden px-3 py-3 text-right tabular-nums md:table-cell">{r.page_count}</td>
                    <td className="hidden px-3 py-3 text-right text-muted tabular-nums md:table-cell">{duration(r.duration_ms)}</td>
                    <td className="px-3 py-3 text-muted" title={dateTime(r.created_at)}>{timeAgo(r.created_at)}</td>
                    <td className="px-3 py-3 text-right">
                      <Menu label="Run actions" trigger={(p) => <IconButton {...p} size="sm" label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
                        { heading: "Download" },
                        ...(["csv", "xlsx", "json", "ndjson"] as const).map((f) => ({ label: f.toUpperCase(), icon: <Download />, href: `/api/runs/${r.id}/export?format=${f}`, download: true })),
                        { separator: true as const },
                        ...(r.recipe_id ? [{ label: "Open task", href: `/tasks/${r.recipe_id}` }] : []),
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm([r.id]) },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load more</Button></div>}
      </Card>
      <p className="mt-3 text-xs text-muted">Scaper keeps the newest results up to the limit in <Link prefetch={false} href="/settings?tab=data" className="text-accent hover:underline">Settings → Data</Link>.</p>

      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void remove(confirm)} busy={deleting}
        title={confirm?.length === 1 ? "Delete this result?" : `Delete ${confirm?.length ?? 0} results?`} body="The scraped rows are removed. Tasks and their schedules are not affected." />
    </>
  );
}

export default function Page() {
  return <Suspense><DataPage /></Suspense>;
}

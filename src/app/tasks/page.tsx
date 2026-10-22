"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Copy, Database, ListChecks, MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import { ConfirmDialog } from "@/components/dialog";
import { Menu } from "@/components/menu";
import { RunStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, FilterChips, IconButton, LoadingRows, PageHeader, SearchInput, Select } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { hostOf, scheduleText, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";
import { isPaused, isScheduled, TEMPLATES } from "@/components/task-bits";

type Filter = "all" | "scheduled" | "manual" | "paused" | "failing";

const isFailing = (t: Task) => t.last_status === "error" || t.last_status === "blocked";

function TasksPage() {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ tasks: Task[]; tags: string[] }>("/api/tasks");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useQueryState<Filter>("show", "all");
  const [tag, setTag] = useQueryState<string>("tag", "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Task[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const counts = useMemo(() => ({
    all: tasks.length,
    scheduled: tasks.filter((t) => isScheduled(t) && !isPaused(t)).length,
    manual: tasks.filter((t) => !isScheduled(t)).length,
    paused: tasks.filter(isPaused).length,
    failing: tasks.filter(isFailing).length,
  }), [tasks]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks.filter((t) => {
      if (filter === "scheduled" && !(isScheduled(t) && !isPaused(t))) return false;
      if (filter === "manual" && isScheduled(t)) return false;
      if (filter === "paused" && !isPaused(t)) return false;
      if (filter === "failing" && !isFailing(t)) return false;
      if (tag && !t.tags.includes(tag)) return false;
      return !needle || `${t.name} ${t.url} ${t.description} ${t.tags.join(" ")}`.toLowerCase().includes(needle);
    });
  }, [tasks, q, filter, tag]);

  const run = async (t: Task) => {
    setBusy(t.id);
    try {
      const { job } = await api<{ job: { id: string } }>(`/api/tasks/${t.id}/run?wait=0`, { method: "POST" });
      toast.success("Task started", t.name, { label: "Follow", onClick: () => router.push(`/runs/${job.id}`) });
    } catch (e) { toast.error("Could not start", errorText(e)); } finally { setBusy(null); }
  };
  const pause = async (t: Task, paused: boolean) => {
    try {
      await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { paused } });
      toast.success(paused ? "Schedule paused" : "Schedule resumed", t.name);
      void reload();
    } catch (e) { toast.error("Could not change the schedule", errorText(e)); }
  };
  const duplicate = async (t: Task) => {
    try {
      const { task } = await api<{ task: Task }>(`/api/tasks/${t.id}/duplicate`, { method: "POST" });
      toast.success("Task copied", "The copy has no schedule yet.");
      router.push(`/tasks/${task.id}/edit`);
    } catch (e) { toast.error("Could not copy", errorText(e)); }
  };
  const remove = async (list: Task[]) => {
    setBusy("delete");
    try {
      for (const t of list) await api(`/api/tasks/${t.id}`, { method: "DELETE" });
      toast.success(list.length === 1 ? "Task deleted" : `${list.length} tasks deleted`, "Their past runs stay in Data.");
      setSelected(new Set());
      setConfirm(null);
      void reload();
    } catch (e) { toast.error("Could not delete", errorText(e)); } finally { setBusy(null); }
  };
  const runMany = async (list: Task[]) => {
    let ok = 0;
    for (const t of list) {
      try { await api(`/api/tasks/${t.id}/run?wait=0`, { method: "POST" }); ok++; } catch { /* reported below */ }
    }
    toast.success(`${ok} of ${list.length} tasks started`, "Follow them on the Runs page.", { label: "Runs", onClick: () => router.push("/runs") });
    setSelected(new Set());
  };

  const chosen = shown.filter((t) => selected.has(t.id));
  const allChecked = shown.length > 0 && chosen.length === shown.length;

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Saved scrapers: many pages, schedules, change alerts and exports."
        actions={<>
          <Link href="/scrape"><Button variant="secondary">Quick scrape</Button></Link>
          <Link href="/tasks/new"><Button icon={<Plus className="size-4" />}>New task</Button></Link>
        </>}
      />

      {error ? <ErrorNote message={error} onRetry={reload} /> : loading ? <Card><LoadingRows rows={5} /></Card> : tasks.length === 0 ? (
        <Card>
          <EmptyState icon={<ListChecks className="size-5" />} title="No tasks yet" action={<Link href="/tasks/new"><Button icon={<Plus className="size-4" />}>New task</Button></Link>}>
            A task remembers how to scrape a site, runs on a schedule and tells you when the data changes. Start from a template:
          </EmptyState>
          <div className="grid gap-3 border-t border-border p-5 sm:grid-cols-2 xl:grid-cols-3">
            {TEMPLATES.map((t) => (
              <Link key={t.id} href={`/tasks/new?template=${t.id}`} className="rounded-xl border border-border p-4 transition-colors hover:border-accent hover:bg-accent-soft/30">
                <p className="flex items-center gap-2 font-medium">{t.icon}{t.title}</p>
                <p className="mt-1 text-sm text-muted">{t.description}</p>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <FilterChips label="Show" value={filter} onChange={setFilter} options={[
              { value: "all", label: "All", count: counts.all },
              { value: "scheduled", label: "Scheduled", count: counts.scheduled },
              { value: "manual", label: "Manual", count: counts.manual },
              { value: "paused", label: "Paused", count: counts.paused },
              { value: "failing", label: "Failing", count: counts.failing },
            ]} />
            <div className="flex gap-2">
              {Boolean(data?.tags.length) && (
                <Select aria-label="Tag" className="h-10 w-40" value={tag} onChange={(e) => setTag(e.target.value)}>
                  <option value="">All tags</option>
                  {data!.tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              )}
              <SearchInput value={q} onChange={setQ} placeholder="Search tasks" className="w-full lg:w-64" />
            </div>
          </div>

          {chosen.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft/30 px-4 py-2.5 text-sm">
              <span className="font-medium">{chosen.length} selected</span>
              <Button size="sm" variant="secondary" icon={<Play className="size-4" />} onClick={() => void runMany(chosen)}>Run</Button>
              <Button size="sm" variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(chosen)}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          {shown.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">No tasks match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2/60 text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 px-4 py-2.5"><Checkbox hideLabel label="Select all" checked={allChecked} indeterminate={chosen.length > 0} onChange={(v) => setSelected(v ? new Set(shown.map((t) => t.id)) : new Set())} /></th>
                    <th className="px-3 py-2.5 font-medium">Task</th>
                    <th className="hidden px-3 py-2.5 font-medium md:table-cell">Schedule</th>
                    <th className="px-3 py-2.5 font-medium">Last run</th>
                    <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Runs</th>
                    <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-2/40">
                      <td className="px-4 py-3 align-top"><Checkbox hideLabel label={`Select ${t.name}`} checked={selected.has(t.id)} onChange={(v) => { const n = new Set(selected); if (v) n.add(t.id); else n.delete(t.id); setSelected(n); }} /></td>
                      <td className="max-w-md px-3 py-3">
                        <Link href={`/tasks/${t.id}`} className="font-medium hover:text-accent">{t.name}</Link>
                        <p className="truncate text-xs text-muted">{hostOf(t.url)} · {t.mode} · {t.extract.type === "selectors" ? `${t.extract.fields.length} fields` : t.extract.type}{t.options.startUrls.length ? ` · ${t.options.startUrls.length + 1} start URLs` : ""}{t.options.crawl.enabled ? " · crawl" : ""}{t.options.detail.enabled ? " · detail pages" : ""}</p>
                        {t.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{t.tags.map((x) => <Badge key={x}>{x}</Badge>)}</div>}
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        {isPaused(t) ? <Badge tone="warning"><Pause className="size-3" />paused</Badge> : <span className="text-sm">{scheduleText(t.schedule_minutes, t.cron)}</span>}
                        {t.next_run_at && <p className="text-xs text-muted">next {timeAgo(t.next_run_at)}</p>}
                      </td>
                      <td className="px-3 py-3">
                        <RunStatusBadge status={t.last_status} />
                        {t.last_run_at && <p className="mt-0.5 text-xs text-muted">{timeAgo(t.last_run_at)}</p>}
                      </td>
                      <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">{t.run_count}</td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy === t.id} onClick={() => void run(t)}>Run</Button>
                          <Menu label={`Actions for ${t.name}`} trigger={(p) => <IconButton {...p} label="More actions" size="sm"><MoreHorizontal className="size-4" /></IconButton>} items={[
                            { label: "Edit", icon: <Pencil />, href: `/tasks/${t.id}/edit` },
                            { label: "Latest data", icon: <Database />, href: `/history?task=${t.id}` },
                            { label: "Duplicate", icon: <Copy />, onSelect: () => void duplicate(t) },
                            ...(isScheduled(t) ? [{ label: isPaused(t) ? "Resume schedule" : "Pause schedule", icon: <CalendarClock />, onSelect: () => void pause(t, !isPaused(t)) }] : []),
                            { separator: true as const },
                            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm([t]) },
                          ]} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void remove(confirm)}
        busy={busy === "delete"}
        title={confirm?.length === 1 ? `Delete “${confirm[0]!.name}”?` : `Delete ${confirm?.length ?? 0} tasks?`}
        body="The task and its schedule are removed. Data from past runs stays on the Data page until you delete it."
      />
    </>
  );
}

export default function Page() {
  return <Suspense><TasksPage /></Suspense>;
}

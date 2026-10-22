"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, AlertOctagon, Bot, CheckCircle2, Gauge, Inbox, ListChecks, Radar, ShieldCheck } from "lucide-react";
import type { Diagnosis } from "@/lib/types";
import { StatusStrip, ScoreBadge, dailyCells, statusLabel } from "@/components/ops-bits";
import { RunStatusBadge } from "@/components/status";
import { Badge, Card, CardHeader, EmptyState, ErrorNote, FilterChips, LoadingRows, PageHeader, SearchInput, Stat } from "@/components/ui";
import { cn } from "@/lib/cn";
import { duration, hostOf, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Fleet = {
  summary: {
    tasks: number; unhealthyTasks: number; watchers: number; failingWatchers: number; successRate30d: number | null; runs30d: number;
    openIssues: number; pendingRepairs: number; changes: { total: number; unreviewed: number; important: number; importantUnreviewed: number };
  };
  daily: { day: string; ok: number; failed: number; other: number }[];
  tasks: {
    id: string; name: string; url: string; tags: string[]; scheduled: boolean; lastStatus: string | null; lastRunAt: string | null; lastRows: number | null; lastScore: number | null;
    runs: number; successRate: number | null; p95: number | null; strip: { at: string; status: string; rows: number }[]; diagnosis: Diagnosis | null;
    openIssues: number; unhealthy: boolean; healMode: "off" | "ask" | "auto";
  }[];
  watchers: {
    id: string; name: string; url: string; tags: string[]; enabled: boolean; lastStatus: string | null; lastCheckedAt: string | null; failCount: number;
    lastError: string | null; checks: number; changes: number; type: string; avgMs: number | null; maxMs: number | null;
  }[];
  errorGroups: { key: string; title: string; area: string; count: number; last: string; affected: number; items: { kind: "task" | "watcher"; id: string; name: string }[] }[];
};

const FAILED = new Set(["error", "blocked"]);
const AREA_LABEL: Record<string, string> = { site: "Website", setup: "Setup", data: "Data", scaper: "Scaper" };

function Operations() {
  const { data, error, loading, reload } = useApi<Fleet>("/api/operations");
  const [filter, setFilter] = useQueryState<"all" | "attention" | "healthy">("show", "all");
  const [q, setQ] = useState("");
  const tasks = useMemo(() => {
    const list = data?.tasks ?? [];
    const needs = (t: Fleet["tasks"][number]) => t.unhealthy || (t.lastStatus !== null && FAILED.has(t.lastStatus)) || t.openIssues > 0 || Boolean(t.diagnosis);
    return list
      .filter((t) => (filter === "all" ? true : filter === "attention" ? needs(t) : !needs(t)))
      .filter((t) => !q || `${t.name} ${t.url} ${t.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => Number(needs(b)) - Number(needs(a)) || (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
  }, [data, filter, q]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <><PageHeader title="Operations" /><Card><LoadingRows rows={8} /></Card></>;
  const s = data.summary;
  const attention = data.tasks.filter((t) => t.unhealthy || (t.lastStatus !== null && FAILED.has(t.lastStatus)) || t.openIssues > 0 || t.diagnosis).length;
  const watchers = [...data.watchers].sort((a, b) => b.failCount - a.failCount || (b.lastCheckedAt ?? "").localeCompare(a.lastCheckedAt ?? ""));

  return (
    <>
      <PageHeader title="Operations" description="Is everything doing its job? Health of every task and watcher, failures grouped by cause, and what waits for you." />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Success, 30 days" icon={<Activity className="size-4" />} value={s.successRate30d === null ? "—" : `${s.successRate30d}%`} hint={plural(s.runs30d, "task run")} />
          <Stat label="Tasks need attention" icon={<ListChecks className="size-4" />} value={<span className={s.unhealthyTasks ? "text-danger" : undefined}>{s.unhealthyTasks}</span>} hint={`of ${s.tasks}`} />
          <Stat label="Watchers failing" icon={<Radar className="size-4" />} value={<span className={s.failingWatchers ? "text-danger" : undefined}>{s.failingWatchers}</span>} hint={`of ${s.watchers}`} />
          <Stat label="Open data issues" icon={<ShieldCheck className="size-4" />} value={s.openIssues} />
          <Stat label="Repairs to review" icon={<Bot className="size-4" />} value={<span className={s.pendingRepairs ? "text-accent" : undefined}>{s.pendingRepairs}</span>} />
          <Link prefetch={false} href="/changes?status=unreviewed" className="rounded-[var(--radius-card)] transition-shadow hover:shadow-pop">
            <Stat label="Changes to review" icon={<Inbox className="size-4" />} value={s.changes.unreviewed} hint={s.changes.importantUnreviewed ? `${s.changes.importantUnreviewed} important` : "none important"} />
          </Link>
        </div>

        <Card>
          <CardHeader title="All task runs, last 30 days" description="One bar per day across every task. Hover for the numbers." />
          <div className="px-4 pb-4"><StatusStrip cells={dailyCells(data.daily)} label="Task run outcomes per day, last 30 days" height={36} /></div>
        </Card>

        <Card>
          <CardHeader title="Failures by cause" description="The last 7 days, grouped so one site change shows up once, with everything it affects." />
          {!data.errorGroups.length ? (
            <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted"><CheckCircle2 className="size-4 text-success" />No failures in the last 7 days.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.errorGroups.map((g) => (
                <li key={g.key} className="flex flex-wrap items-start gap-3 px-5 py-3">
                  <AlertOctagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{g.title}</p>
                      <Badge>{AREA_LABEL[g.area] ?? g.area}</Badge>
                    </div>
                    <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                      {g.items.map((i) => (
                        <Link key={`${i.kind}${i.id}`} prefetch={false} href={i.kind === "task" ? `/tasks/${i.id}?view=health` : `/watchers/${i.id}`} className="rounded-full border border-border px-2 py-0.5 text-muted hover:border-accent hover:text-accent">
                          {i.kind === "watcher" ? "Watcher · " : ""}{i.name}
                        </Link>
                      ))}
                      {g.affected > g.items.length && <span className="px-1 py-0.5 text-muted">+{g.affected - g.items.length} more</span>}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted">
                    <p className="font-semibold text-text tabular-nums">{plural(g.count, "time")}</p>
                    <p>last {timeAgo(g.last)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Tasks" actions={<SearchInput value={q} onChange={setQ} placeholder="Find a task" className="w-48" />} />
          <div className="px-5 pb-3">
            <FilterChips label="Show" value={filter} onChange={setFilter} options={[
              { value: "all", label: "All", count: data.tasks.length }, { value: "attention", label: "Needs attention", count: attention }, { value: "healthy", label: "Healthy", count: data.tasks.length - attention },
            ]} />
          </div>
          {!data.tasks.length ? <EmptyState icon={<ListChecks className="size-5" />} title="No tasks yet">Saved tasks show up here with their health.</EmptyState> : !tasks.length ? <p className="px-5 pb-5 text-sm text-muted">Nothing matches.</p> : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-y border-border bg-surface-2/50 text-left text-xs text-muted">
                  <tr>
                    <th className="px-5 py-2 font-medium">Task</th>
                    <th className="px-3 py-2 font-medium">Last 30 runs</th>
                    <th className="px-3 py-2 text-right font-medium">Success</th>
                    <th className="px-3 py-2 text-right font-medium">p95 time</th>
                    <th className="px-3 py-2 text-right font-medium">Rows</th>
                    <th className="px-3 py-2 font-medium">Data</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tasks.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-2/30">
                      <td className="max-w-[260px] px-5 py-2.5">
                        <Link prefetch={false} href={`/tasks/${t.id}?view=health`} className="block truncate font-medium hover:text-accent">{t.name}</Link>
                        <span className="block truncate text-xs text-muted">{hostOf(t.url)}{t.scheduled ? " · scheduled" : ""}{t.healMode === "auto" ? " · auto-repair" : ""}</span>
                      </td>
                      <td className="w-[200px] px-3 py-2.5">
                        {t.strip.length ? <StatusStrip height={20} label={`Last ${t.strip.length} runs of ${t.name}`} cells={t.strip.map((r, i) => ({ key: `${i}`, status: r.status === "ok" ? "ok" : r.status === "partial" ? "partial" : FAILED.has(r.status) ? "failed" : "none", title: `${timeAgo(r.at)}: ${statusLabel(r.status)}, ${plural(r.rows, "row")}` }))} />
                          : <span className="text-xs text-muted">no runs in 30 days</span>}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums", t.successRate !== null && t.successRate < 90 && "font-medium text-danger")}>{t.successRate === null ? "—" : `${t.successRate}%`}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted">{duration(t.p95)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{t.lastRows === null ? "—" : t.lastRows.toLocaleString("en-IN")}</td>
                      <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5"><ScoreBadge score={t.lastScore} />{t.openIssues > 0 && <Badge tone="warning">{plural(t.openIssues, "issue")}</Badge>}</span></td>
                      <td className="max-w-[240px] px-3 py-2.5">
                        <div className="flex items-center gap-1.5"><RunStatusBadge status={t.lastStatus} />{t.unhealthy && <Badge tone="danger">Unhealthy</Badge>}</div>
                        {t.diagnosis && <p className={cn("mt-0.5 truncate text-xs", t.diagnosis.severity === "error" ? "text-danger" : "text-warning")} title={t.diagnosis.detail}>{t.diagnosis.title}</p>}
                        {!t.diagnosis && t.lastRunAt && <p className="mt-0.5 text-xs text-muted">{timeAgo(t.lastRunAt)}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Watchers" description="Response time over the last 7 days and failures in a row." />
          {!watchers.length ? <EmptyState icon={<Radar className="size-5" />} title="No watchers yet">Watchers show up here with their health.</EmptyState> : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-y border-border bg-surface-2/50 text-left text-xs text-muted">
                  <tr><th className="px-5 py-2 font-medium">Watcher</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 text-right font-medium">Avg / max response</th><th className="px-3 py-2 text-right font-medium">Checks</th><th className="px-3 py-2 text-right font-medium">Changes</th><th className="px-3 py-2 font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {watchers.map((w) => (
                    <tr key={w.id} className={cn("hover:bg-surface-2/30", !w.enabled && "opacity-60")}>
                      <td className="max-w-[280px] px-5 py-2.5">
                        <Link prefetch={false} href={`/watchers/${w.id}`} className="block truncate font-medium hover:text-accent">{w.name}</Link>
                        <span className="block truncate text-xs text-muted">{hostOf(w.url)}</span>
                      </td>
                      <td className="px-3 py-2.5 text-muted">{w.type}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted">{w.avgMs === null ? "—" : `${duration(w.avgMs)} / ${duration(w.maxMs)}`}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{w.checks.toLocaleString("en-IN")}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{w.changes.toLocaleString("en-IN")}</td>
                      <td className="max-w-[260px] px-3 py-2.5">
                        {!w.enabled ? <Badge>Paused</Badge> : w.failCount ? <Badge tone="danger">Failed {plural(w.failCount, "time")} in a row</Badge> : <Badge tone="success">OK</Badge>}
                        {w.failCount > 0 && w.lastError && <p className="mt-0.5 truncate text-xs text-danger" title={w.lastError}>{w.lastError}</p>}
                        {!w.failCount && w.lastCheckedAt && <p className="mt-0.5 text-xs text-muted">checked {timeAgo(w.lastCheckedAt)}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <p className="flex items-center gap-1.5 text-xs text-muted"><Gauge className="size-3.5" />Health alerts (too few rows, too slow, failing in a row) are set per task under Edit → Alerts.</p>
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense><Operations /></Suspense>;
}

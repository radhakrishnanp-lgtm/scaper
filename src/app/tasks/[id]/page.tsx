"use client";

import { Suspense, use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Code2, Copy, Database, Eraser, History, MoreHorizontal, Pause, Pencil, Play, Trash2, Webhook } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import type { Job } from "@/server/repo/jobs";
import { BarChart } from "@/components/charts";
import { CopyButton } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialog";
import { useLive } from "@/components/live";
import { Menu } from "@/components/menu";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { JobStatusBadge, RunStatusBadge } from "@/components/status";
import { describeTask, isPaused, isScheduled } from "@/components/task-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, IconButton, KeyValue, LoadingRows, PageHeader, Progress, Stat, Tabs } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime, duration, hostOf, plural, scheduleText, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Detail = { task: Task; trend: { created_at: string; row_count: number; status: string; duration_ms: number }[]; jobs: Job[]; seen: number; nextRuns: string[] };
type View = "data" | "runs" | "jobs" | "setup" | "api";

function TaskDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const live = useLive();
  const { data, error, loading, reload } = useApi<Detail>(`/api/tasks/${id}`);
  const runs = useApi<{ items: RunView[]; nextCursor: string | null }>(`/api/runs?recipeId=${id}&limit=25`);
  const latestId = runs.data?.items[0]?.id ?? null;
  const latest = useApi<{ run: RunView }>(latestId ? `/api/runs/${latestId}` : null);
  const [view, setView] = useQueryState<View>("view", "data");
  const [confirm, setConfirm] = useState<"delete" | "seen" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const running = live.active.find((j) => j.ref_id === id && (j.status === "running" || j.status === "queued"));
  const trend = useMemo(() => (data?.trend ?? []).map((r) => ({
    label: new Date(r.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    values: { ok: r.status === "ok" ? r.row_count : 0, partial: r.status === "partial" ? r.row_count : 0 },
  })), [data]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  const t = data.task;
  const okRuns = data.trend.filter((r) => r.status === "ok" || r.status === "partial");
  const avgMs = okRuns.length ? okRuns.reduce((s, r) => s + r.duration_ms, 0) / okRuns.length : null;
  const failures = data.trend.slice(-10).filter((r) => r.status === "error" || r.status === "blocked").length;
  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;

  const runNow = async () => {
    setBusy("run");
    try {
      await api(`/api/tasks/${id}/run?wait=0`, { method: "POST" });
      toast.success("Task started", "Progress shows here and in the top bar.");
      live.refreshJobs();
    } catch (e) { toast.error("Could not start", errorText(e)); } finally { setBusy(null); }
  };
  const pause = async (paused: boolean) => {
    try { await api(`/api/tasks/${id}`, { method: "PATCH", body: { paused } }); toast.success(paused ? "Schedule paused" : "Schedule resumed"); void reload(); }
    catch (e) { toast.error("Could not change the schedule", errorText(e)); }
  };
  const duplicate = async () => {
    try { const { task } = await api<{ task: Task }>(`/api/tasks/${id}/duplicate`, { method: "POST" }); router.push(`/tasks/${task.id}/edit`); }
    catch (e) { toast.error("Could not copy", errorText(e)); }
  };
  const doConfirm = async () => {
    setBusy("confirm");
    try {
      if (confirm === "delete") { await api(`/api/tasks/${id}`, { method: "DELETE" }); toast.success("Task deleted"); router.push("/tasks"); return; }
      const { removed } = await api<{ removed: number }>(`/api/tasks/${id}/seen`, { method: "DELETE" });
      toast.success("Memory cleared", `${removed} remembered items forgotten. The next run opens every detail page again.`);
      void reload();
    } catch (e) { toast.error("Something went wrong", errorText(e)); } finally { setBusy(null); setConfirm(null); }
  };

  const summary = describeTask({
    url: t.url, mode: t.mode, extract: t.extract.type === "selectors" ? { ...t.extract, itemSelector: t.extract.itemSelector ?? "" } : t.extract, options: t.options,
    startCount: t.options.startUrls.length, scheduleMinutes: t.schedule_minutes, cron: t.cron,
    channels: Object.entries(t.options.monitor.channels).filter(([, v]) => v).map(([k]) => (k === "desktop" ? "inbox" : k)),
  });

  return (
    <>
      <PageHeader
        title={t.name}
        description={<><a href={t.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{hostOf(t.url)}</a> · {t.mode} · {scheduleText(t.schedule_minutes, t.cron)}{t.tags.map((x) => <Badge key={x} className="ml-1.5">{x}</Badge>)}</>}
        actions={<>
          <Button icon={<Play className="size-4" />} loading={busy === "run"} disabled={Boolean(running)} onClick={runNow}>{running ? "Running…" : "Run now"}</Button>
          <Link href={`/tasks/${id}/edit`}><Button variant="secondary" icon={<Pencil className="size-4" />}>Edit</Button></Link>
          <Menu label="More task actions" trigger={(p) => <IconButton {...p} label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: "Duplicate", icon: <Copy />, onSelect: () => void duplicate() },
            ...(isScheduled(t) ? [{ label: isPaused(t) ? "Resume schedule" : "Pause schedule", icon: <CalendarClock />, onSelect: () => void pause(!isPaused(t)) }] : []),
            ...(data.seen ? [{ label: `Forget ${data.seen} seen items`, icon: <Eraser />, onSelect: () => setConfirm("seen") }] : []),
            { label: "All data from this task", icon: <Database />, href: `/history?task=${id}` },
            { separator: true as const },
            { label: "Delete task", icon: <Trash2 />, danger: true, onSelect: () => setConfirm("delete") },
          ]} />
        </>}
      />

      <div className="space-y-6">
        {running && (
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2"><JobStatusBadge status={running.status} />{running.progress.label ?? "Starting…"}</span>
              <Link href={`/runs/${running.id}`} className="font-medium text-accent hover:underline">Live log</Link>
            </div>
            <Progress className="mt-3" label="Task progress" value={running.progress.total ? running.progress.done ?? 0 : null} max={running.progress.total ?? 100} />
            {running.progress.rows !== undefined && <p className="mt-1.5 text-xs text-muted">{plural(running.progress.rows, "row")} so far</p>}
          </Card>
        )}
        {isPaused(t) && <Callout tone="warning" icon={<Pause className="size-4 text-warning" />} title="The schedule is paused" action={<Button size="sm" variant="secondary" onClick={() => void pause(false)}>Resume</Button>}>It keeps its settings and runs when you press Run now.</Callout>}
        {failures >= 3 && <Callout tone="danger" title={`${failures} of the last 10 runs failed`}>Open a failed run on the Jobs tab to see why. A site redesign usually means a selector needs updating.</Callout>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Last run" value={<RunStatusBadge status={t.last_status} />} hint={timeAgo(t.last_run_at)} />
          <Stat label="Rows last run" value={(data.trend.at(-1)?.row_count ?? 0).toLocaleString("en-IN")} />
          <Stat label="Runs" value={t.run_count} hint={`${okRuns.length} of the last ${data.trend.length} ok`} />
          <Stat label="Average time" value={duration(avgMs === null ? null : Math.round(avgMs))} />
          <Stat label="Next run" value={<span className="text-base">{data.nextRuns[0] ? timeAgo(data.nextRuns[0]) : isPaused(t) ? "paused" : "manual"}</span>} hint={data.nextRuns[0] ? dateTime(data.nextRuns[0]) : undefined} />
        </div>

        {trend.length > 1 && (
          <Card>
            <CardHeader title="Rows per run" description={`Last ${plural(trend.length, "run")}. A sudden drop usually means the site changed.`} />
            <div className="p-4">
              <BarChart label="Rows per run" height={150} data={trend} series={[{ key: "ok", label: "ok", color: "var(--accent)" }, { key: "partial", label: "partial", color: "var(--warning)" }]} />
            </div>
          </Card>
        )}

        <div>
          <Tabs value={view} onChange={setView} tabs={[
            { value: "data", label: "Latest data", icon: <Database className="size-4" /> },
            { value: "runs", label: "Runs", icon: <History className="size-4" />, count: runs.data?.items.length ?? null },
            { value: "jobs", label: "Jobs", count: data.jobs.length },
            { value: "setup", label: "Setup" },
            { value: "api", label: "API", icon: <Code2 className="size-4" /> },
          ]} />
          <div className="mt-4">
            {view === "data" && (
              !latestId ? (
                <Card><EmptyState icon={<Database className="size-5" />} title="No data yet" action={<Button icon={<Play className="size-4" />} onClick={runNow} loading={busy === "run"}>Run now</Button>}>Run the task to see its data here.</EmptyState></Card>
              ) : latest.loading || !latest.data ? <Card><LoadingRows /></Card> : <ScrapeResultView run={latest.data.run} />
            )}

            {view === "runs" && (
              <Card>
                {!runs.data?.items.length ? <p className="p-5 text-sm text-muted">No runs yet.</p> : (
                  <ul className="divide-y divide-border">
                    {runs.data.items.map((r) => (
                      <li key={r.id}>
                        <Link href={`/history/${r.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-2/40">
                          <RunStatusBadge status={r.status} />
                          <span className="text-sm">{dateTime(r.created_at)}</span>
                          <span className="text-sm text-muted tabular-nums">{plural(r.row_count, "row")} · {plural(r.page_count, "page")} · {duration(r.duration_ms)}</span>
                          {r.error && <span className="w-full truncate text-xs text-danger">{r.error}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {view === "jobs" && (
              <Card>
                {!data.jobs.length ? <p className="p-5 text-sm text-muted">No jobs yet.</p> : (
                  <ul className="divide-y divide-border">
                    {data.jobs.map((j) => (
                      <li key={j.id}>
                        <Link href={`/runs/${j.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-2/40">
                          <JobStatusBadge status={j.status} />
                          <span className="text-sm">{dateTime(j.created_at)}</span>
                          <Badge>{j.trigger}</Badge>
                          <span className="text-sm text-muted">{duration(j.duration_ms)}{j.attempts > 1 ? ` · ${j.attempts} attempts` : ""}</span>
                          {j.error && <span className="w-full truncate text-xs text-danger">{j.error}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {view === "setup" && (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card className="p-5">
                  <p className="text-sm font-semibold">What this task does</p>
                  <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted">{summary.map((s, i) => <li key={i}>{s}</li>)}</ol>
                </Card>
                <Card className="p-5">
                  <KeyValue items={[
                    { label: "Start URL", value: <a href={t.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">{t.url}</a> },
                    { label: "Created", value: dateTime(t.created_at) },
                    { label: "Last changed", value: dateTime(t.updated_at) },
                    { label: "Next runs", value: data.nextRuns.length ? <ul>{data.nextRuns.slice(0, 5).map((r) => <li key={r}>{dateTime(r)}</li>)}</ul> : "—" },
                    { label: "Remembered items", value: data.seen ? `${data.seen.toLocaleString("en-IN")} (skipped by incremental runs)` : "—" },
                    { label: "Notes", value: t.description || "—" },
                  ]} />
                </Card>
              </div>
            )}

            {view === "api" && (
              <Card className="space-y-4 p-5 text-sm">
                <p className="text-muted">Start this task from scripts, cron jobs or other tools on this computer. Create a token in <Link href="/settings?tab=api" className="text-accent hover:underline">Settings → API</Link>.</p>
                {[
                  { label: "Run and wait for the result (up to 90 s)", cmd: `curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" ${origin}/api/tasks/${id}/run` },
                  { label: "Start without waiting", cmd: `curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" "${origin}/api/tasks/${id}/run?wait=0"` },
                  { label: "Latest data as CSV", cmd: latestId ? `curl -H "Authorization: Bearer $SCAPER_TOKEN" "${origin}/api/runs/${latestId}/export?format=csv" -o data.csv` : "Run the task once first." },
                ].map((c) => (
                  <div key={c.label}>
                    <div className="mb-1 flex items-center justify-between"><p className="font-medium">{c.label}</p><CopyButton text={c.cmd} /></div>
                    <pre className="scroll-thin overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{c.cmd}</pre>
                  </div>
                ))}
                <p className="flex items-center gap-1.5 text-muted"><Webhook className="size-4" />Turn on “Send rows to my webhook” in the task to push data out after each run instead.</p>
              </Card>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
        busy={busy === "confirm"}
        title={confirm === "delete" ? `Delete “${t.name}”?` : "Forget seen items?"}
        confirmLabel={confirm === "delete" ? "Delete" : "Forget"}
        body={confirm === "delete" ? "The task and its schedule are removed. Data from past runs stays on the Data page." : "The next run will open every detail page again, which takes longer."}
      />
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><TaskDetail id={id} /></Suspense>;
}

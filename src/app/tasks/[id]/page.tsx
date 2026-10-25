"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, CalendarClock, Code2, Copy, Database, Eraser, GitBranch, History, MoreHorizontal, Pause, Pencil, Play, ShieldCheck, Sparkles, Trash2, Webhook, Wrench } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import type { Job } from "@/server/repo/jobs";
import { CopyButton } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialog";
import { useLive } from "@/components/live";
import { ChecksTab, diagnosisActions, HealDialog, HealthTab, PendingRepair, RepairsTab, VersionsTab } from "@/components/task-ops";
import type { HealProposal } from "@/server/repo/heal";
import { Menu } from "@/components/menu";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { JobStatusBadge, RunStatusBadge } from "@/components/status";
import { describeTask, isPaused, isScheduled } from "@/components/task-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, IconButton, KeyValue, LoadingRows, PageHeader, Progress, Stat, Tabs } from "@/components/ui";
import { DiagnosisCard, ScoreBadge } from "@/components/ops-bits";
import { api, errorText } from "@/lib/api-client";
import { dateTime, duration, hostOf, plural, scheduleText, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Detail = { task: Task; trend: { created_at: string; row_count: number; status: string; duration_ms: number }[]; jobs: Job[]; seen: number; nextRuns: string[]; pendingRepair: HealProposal | null; openIssues: number; versions: number };
type View = "data" | "health" | "checks" | "runs" | "jobs" | "versions" | "repairs" | "setup" | "api";
const HIDDEN_SETS = ["Links", "Images", "Headings"];
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
  const [fix, setFix] = useQueryState<string>("fix", "");
  const heal = fix === "1";
  const setHeal = (v: boolean) => setFix(v ? "1" : "");

  const running = live.active.find((j) => j.ref_id === id && (j.status === "running" || j.status === "queued"));

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  const t = data.task;
  const latestRun = latest.data?.run;
  const latestDiagnosis = runs.data?.items[0]?.diagnosis ?? null;
  const mainDataset = latestRun?.result ? latestRun.result.datasets.find((d) => !HIDDEN_SETS.includes(d.name)) ?? latestRun.result.datasets[0] ?? null : null;
  const okRuns = data.trend.filter((r) => r.status === "ok" || r.status === "partial");
  const avgMs = okRuns.length ? okRuns.reduce((s, r) => s + r.duration_ms, 0) / okRuns.length : null;
  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;

  const pauseRun = async (jobId: string) => {
    setBusy("pause-run");
    try {
      const r = await api<{ message?: string }>(`/api/jobs/${jobId}/pause`, { method: "POST" });
      toast.success(r.message ?? "Pausing", "Resume it from Runs, or press Run now.");
    } catch (e) { toast.error("Could not pause", errorText(e)); } finally { setBusy(null); }
  };
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

  const diagActions = diagnosisActions(t, { heal: () => setHeal(true), retry: () => void runNow() });

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
          <Link prefetch={false} href={`/tasks/${id}/edit`}><Button variant="secondary" icon={<Pencil className="size-4" />}>Edit</Button></Link>
          <Menu label="More task actions" trigger={(p) => <IconButton {...p} label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
            ...(t.extract.type === "selectors" ? [{ label: "Fix selectors with AI", icon: <Sparkles />, onSelect: () => setHeal(true) }] : []),
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
              <span className="flex items-center gap-3">
                <Button size="sm" variant="ghost" icon={<Pause className="size-4" />} loading={busy === "pause-run"} onClick={() => void pauseRun(running.id)}>Pause</Button>
                <Link prefetch={false} href={`/runs/${running.id}`} className="font-medium text-accent hover:underline">Live log</Link>
              </span>
            </div>
            <Progress className="mt-3" label="Task progress" value={running.progress.total ? running.progress.done ?? 0 : null} max={running.progress.total ?? 100} />
            {running.progress.rows !== undefined && <p className="mt-1.5 text-xs text-muted">{plural(running.progress.rows, "row")} so far</p>}
          </Card>
        )}
        {isPaused(t) && <Callout tone="warning" icon={<Pause className="size-4 text-warning" />} title="The schedule is paused" action={<Button size="sm" variant="secondary" onClick={() => void pause(false)}>Resume</Button>}>It keeps its settings and runs when you press Run now.</Callout>}
        {data.pendingRepair && view !== "health" && view !== "repairs" && <PendingRepair taskId={id} p={data.pendingRepair} compact onDone={() => { void reload(); void runs.reload(); }} />}
        {latestDiagnosis && view !== "health" && view !== "data" && <DiagnosisCard d={latestDiagnosis} compact {...diagActions} />}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Last run" value={<RunStatusBadge status={t.last_status} />} hint={timeAgo(t.last_run_at)} />
          <Stat label="Rows last run" value={(data.trend.at(-1)?.row_count ?? 0).toLocaleString("en-IN")} />
          <Stat label="Runs" value={t.run_count} hint={`${okRuns.length} of the last ${data.trend.length} ok`} />
          <Stat label="Average time" value={duration(avgMs === null ? null : Math.round(avgMs))} />
          <Stat label="Next run" value={<span className="text-base">{data.nextRuns[0] ? timeAgo(data.nextRuns[0]) : isPaused(t) ? "paused" : "manual"}</span>} hint={data.nextRuns[0] ? dateTime(data.nextRuns[0]) : undefined} />
        </div>

        <div>
          <Tabs value={view} onChange={setView} tabs={[
            { value: "data", label: "Latest data", icon: <Database className="size-4" /> },
            { value: "health", label: "Health", icon: <Activity className="size-4" /> },
            { value: "checks", label: "Checks", icon: <ShieldCheck className="size-4" />, count: data.openIssues || null },
            { value: "runs", label: "Runs", icon: <History className="size-4" />, count: runs.data?.items.length ?? null },
            { value: "jobs", label: "Jobs", count: data.jobs.length },
            { value: "versions", label: "Versions", icon: <GitBranch className="size-4" />, count: data.versions > 1 ? data.versions : null },
            { value: "repairs", label: "Repairs", icon: <Wrench className="size-4" />, count: data.pendingRepair ? 1 : null, hidden: t.extract.type !== "selectors" },
            { value: "setup", label: "Setup" },
            { value: "api", label: "API", icon: <Code2 className="size-4" /> },
          ]} />
          <div className="mt-4">
            {view === "data" && (
              !latestId ? (
                <Card><EmptyState icon={<Database className="size-5" />} title="No data yet" action={<Button icon={<Play className="size-4" />} onClick={runNow} loading={busy === "run"}>Run now</Button>}>Run the task to see its data here.</EmptyState></Card>
              ) : latest.loading || !latest.data ? <Card><LoadingRows /></Card> : <ScrapeResultView run={latest.data.run} />
            )}

            {view === "health" && <HealthTab task={t} onHeal={() => setHeal(true)} onRetry={() => void runNow()} onChanged={() => void reload()} />}
            {view === "checks" && <ChecksTab key={t.version} task={t} dataset={mainDataset} onSaved={() => void reload()} />}
            {view === "versions" && <VersionsTab task={t} onRestored={() => void reload()} />}
            {view === "repairs" && <RepairsTab task={t} onHeal={() => setHeal(true)} onChanged={() => void reload()} />}

            {view === "runs" && (
              <Card>
                {!runs.data?.items.length ? <p className="p-5 text-sm text-muted">No runs yet.</p> : (
                  <ul className="divide-y divide-border">
                    {runs.data.items.map((r) => (
                      <li key={r.id}>
                        <Link prefetch={false} href={`/history/${r.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-2/40">
                          <RunStatusBadge status={r.status} />
                          <span className="text-sm">{dateTime(r.created_at)}</span>
                          <span className="text-sm text-muted tabular-nums">{plural(r.row_count, "row")} · {plural(r.page_count, "page")} · {duration(r.duration_ms)}</span>
                          {r.score !== null && r.score !== undefined && <ScoreBadge score={r.score} status={r.validation?.status} />}
                          {r.version ? <Badge>v{r.version}</Badge> : null}
                          {r.diagnosis ? <span className={r.diagnosis.severity === "error" ? "w-full truncate text-xs text-danger" : "w-full truncate text-xs text-warning"}>{r.diagnosis.title}</span>
                            : r.error && <span className="w-full truncate text-xs text-danger">{r.error}</span>}
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
                        <Link prefetch={false} href={`/runs/${j.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-2/40">
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
                <p className="text-muted">Start this task from scripts, cron jobs or other tools on this computer. Create a token in <Link prefetch={false} href="/settings?tab=api" className="text-accent hover:underline">Settings → API</Link>.</p>
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

      {heal && <HealDialog id={id} onClose={() => setHeal(false)} onApplied={() => { setHeal(false); void reload(); }} />}
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

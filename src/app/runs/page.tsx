"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Ban, Eraser, EyeOff, Pause, Play, RotateCcw } from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import { ConfirmDialog } from "@/components/dialog";
import { JOB_KIND_LABEL, jobResultHref, JobStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, ErrorNote, FilterChips, IconButton, LoadingRows, PageHeader, Progress, SearchInput, Select } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { duration, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Counts = { queued: number; running: number; paused: number; succeeded: number; failed: number; cancelled: number };
type JobsPage = { items: Job[]; nextCursor: string | null; counts: Counts };
type StatusFilter = "all" | "active" | "paused" | "failed" | "succeeded" | "cancelled";
/** Kinds that can stop after the current page and carry on later. */
const PAUSABLE = new Set(["task", "scrape"]);

function RunsPage() {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useQueryState<StatusFilter>("status", "all");
  const [kind, setKind] = useQueryState<string>("kind", "");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const [extra, setExtra] = useState<Job[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (status !== "all") p.set("status", status);
    if (kind) p.set("kind", kind);
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [status, kind, debounced]);
  const { data, error, loading, reload } = useApi<JobsPage>(`/api/jobs?${qs}`);
  const hasActive = data?.items.some((j) => j.status === "running" || j.status === "queued");
  // Running jobs report progress often; refresh while any are on screen.
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [hasActive, reload]);
  // Reset the extra pages when the filters change.
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setCursor(undefined); }

  const items = [...(data?.items ?? []), ...extra];
  const next = cursor === undefined ? data?.nextCursor ?? null : cursor;
  const c = data?.counts;

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await api<JobsPage>(`/api/jobs?${qs}&before=${encodeURIComponent(next)}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) { toast.error("Could not load more", errorText(e)); } finally { setLoadingMore(false); }
  };
  const act = async (j: Job, action: "cancel" | "retry" | "pause" | "resume") => {
    setBusy(j.id + action);
    try {
      const res = await api<{ job: Job; message?: string }>(`/api/jobs/${j.id}/${action}`, { method: "POST" });
      if (action === "retry") toast.success("Started again", j.title, { label: "Follow", onClick: () => router.push(`/runs/${res.job.id}`) });
      else if (action === "pause") toast.success(res.message ?? "Pausing", j.title);
      else if (action === "resume") toast.success(res.message ?? "Resumed", j.title);
      else toast.success("Cancelled", j.title);
      void reload();
    } catch (e) { toast.error(`Could not ${action}`, errorText(e)); } finally { setBusy(null); }
  };
  const all = async (action: "pause" | "resume") => {
    setBusy(action + "all");
    try {
      const r = await api<{ jobs: number; downloads: number }>("/api/jobs/pause-all", { body: { action } });
      toast.success(action === "pause" ? "Paused" : "Resumed", `${plural(r.jobs, "run")} and ${plural(r.downloads, "download")}.${action === "pause" && r.jobs ? " Running tasks stop after their current page." : ""}`);
      void reload();
    } catch (e) { toast.error(`Could not ${action}`, errorText(e)); } finally { setBusy(null); }
  };
  const clearFinished = async () => {
    setBusy("clear");
    try {
      const { removed } = await api<{ removed: number }>("/api/jobs", { method: "DELETE" });
      toast.success("Cleared", `${removed} finished jobs removed. Scraped data is kept.`);
      setClearOpen(false); setExtra([]); setCursor(undefined);
      void reload();
    } catch (e) { toast.error("Could not clear", errorText(e)); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every job Scaper runs: tasks, quick scrapes, watcher checks, price checks, deal searches and backups."
        actions={<>
          {c && c.paused > 0 && <Button variant="secondary" icon={<Play className="size-4" />} loading={busy === "resumeall"} onClick={() => void all("resume")}>Resume all</Button>}
          {c && c.queued + c.running > 0 && <Button variant="secondary" icon={<Pause className="size-4" />} loading={busy === "pauseall"} onClick={() => void all("pause")}>Pause all</Button>}
          <Button variant="secondary" icon={<Eraser className="size-4" />} onClick={() => setClearOpen(true)}>Clear finished</Button>
        </>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Status" value={status} onChange={setStatus} options={[
            { value: "all", label: "All", count: c ? c.queued + c.running + c.paused + c.succeeded + c.failed + c.cancelled : undefined },
            { value: "active", label: "Active", count: c ? c.queued + c.running : undefined },
            { value: "paused", label: "Paused", count: c?.paused },
            { value: "failed", label: "Failed", count: c?.failed },
            { value: "succeeded", label: "Done", count: c?.succeeded },
            { value: "cancelled", label: "Cancelled", count: c?.cancelled },
          ]} />
          <div className="flex gap-2">
            <Select aria-label="Kind" className="h-10 w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {Object.entries(JOB_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
            <SearchInput value={q} onChange={setQ} placeholder="Search runs" className="w-full lg:w-60" />
          </div>
        </div>

        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={6} /> : items.length === 0 ? (
          <EmptyState icon={<Activity className="size-5" />} title={status === "active" ? "Nothing running" : "No runs here"}>
            {status === "all" && !kind && !debounced ? "Run a task, a quick scrape or a watcher check and it appears here." : "Try other filters."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((j) => {
              const href = jobResultHref(j);
              const active = j.status === "running" || j.status === "queued";
              const waiting = j.status === "queued" && Date.parse(j.run_after) > now + 2000;
              return (
                <li key={j.id} className="px-4 py-3 hover:bg-surface-2/40">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <JobStatusBadge status={j.status} />
                    <Badge>{JOB_KIND_LABEL[j.kind] ?? j.kind}</Badge>
                    <Link prefetch={false} href={`/runs/${j.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-accent">{j.private && <Badge className="mr-1.5"><EyeOff className="size-3" />private</Badge>}{j.title}</Link>
                    <span className="text-xs text-muted">{j.trigger} · {timeAgo(j.created_at)}{j.duration_ms !== null && !active ? ` · ${duration(j.duration_ms)}` : ""}{j.attempts > 1 ? ` · attempt ${j.attempts}/${j.max_attempts}` : ""}</span>
                    <div className="flex gap-1">
                      {(j.status === "queued" || (j.status === "running" && PAUSABLE.has(j.kind))) && !j.private && <IconButton size="sm" label="Pause" disabled={busy === j.id + "pause"} onClick={() => void act(j, "pause")}><Pause className="size-4" /></IconButton>}
                      {j.status === "paused" && <IconButton size="sm" label="Resume" disabled={busy === j.id + "resume"} onClick={() => void act(j, "resume")}><Play className="size-4" /></IconButton>}
                      {(active || j.status === "paused") && <IconButton size="sm" label="Cancel" disabled={busy === j.id + "cancel"} onClick={() => void act(j, "cancel")}><Ban className="size-4" /></IconButton>}
                      {(j.status === "failed" || j.status === "cancelled") && <IconButton size="sm" label="Run again" disabled={busy === j.id + "retry"} onClick={() => void act(j, "retry")}><RotateCcw className="size-4" /></IconButton>}
                      {href && !active && <Link prefetch={false} href={href}><Button size="sm" variant="ghost">Result</Button></Link>}
                    </div>
                  </div>
                  {j.status === "running" && (
                    <div className="mt-2 flex items-center gap-3">
                      <Progress className="max-w-sm" label={`Progress of ${j.title}`} value={j.progress.total ? j.progress.done ?? 0 : null} max={j.progress.total ?? 100} />
                      <span className="truncate text-xs text-muted">{j.progress.label}{j.progress.rows !== undefined ? ` · ${plural(j.progress.rows, "row")}` : ""}</span>
                    </div>
                  )}
                  {waiting && <p className="mt-1 text-xs text-muted">Waiting until {new Date(j.run_after).toLocaleTimeString("en-IN")} (retry pause or polite delay)</p>}
                  {j.status === "paused" && <p className="mt-1 text-xs text-muted">{j.error ?? "Paused."}{j.progress.done ? ` ${plural(j.progress.done, "page")} done${j.progress.rows !== undefined ? `, ${plural(j.progress.rows, "row")} so far` : ""}.` : ""}</p>}
                  {j.error && j.status !== "paused" && <p className="mt-1 truncate text-xs text-danger" title={j.error}>{j.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {next && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={loadingMore} onClick={loadMore}>Load more</Button></div>}
      </Card>

      <ConfirmDialog open={clearOpen} onCancel={() => setClearOpen(false)} onConfirm={clearFinished} busy={busy === "clear"} title="Clear finished runs?" confirmLabel="Clear"
        body="Removes done, failed and cancelled jobs and their logs from this list. Scraped data, snapshots and price history are not touched." />
    </>
  );
}

export default function Page() {
  return <Suspense><RunsPage /></Suspense>;
}

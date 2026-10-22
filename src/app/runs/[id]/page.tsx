"use client";

import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Ban, Download, RotateCcw } from "lucide-react";
import type { Job, JobLog } from "@/server/repo/jobs";
import { CopyButton } from "@/components/data-table";
import { JOB_KIND_LABEL, jobResultHref, JobStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, ErrorNote, FilterChips, KeyValue, LoadingRows, PageHeader, Progress } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, duration, plural } from "@/lib/format";

type Level = "all" | "warn" | "error";
const SOURCE: Partial<Record<Job["kind"], (id: string) => string>> = {
  task: (id) => `/tasks/${id}`, watch: (id) => `/watchers/${id}`, product: (id) => `/deals/${id}`,
};

function RunDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("all");
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const lastLog = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const poll = useCallback(async () => {
    try {
      const d = await api<{ job: Job; logs: JobLog[] }>(`/api/jobs/${id}?after=${lastLog.current}`);
      setJob(d.job);
      if (d.logs.length) {
        lastLog.current = Math.max(lastLog.current, d.logs[d.logs.length - 1]!.id);
        // Two polls can overlap (first load and the interval), so skip lines already shown.
        setLogs((l) => {
          const seen = new Set(l.map((x) => x.id));
          const fresh = d.logs.filter((x) => !seen.has(x.id));
          return fresh.length ? [...l, ...fresh] : l;
        });
      }
      setError(null);
    } catch (e) { setError(errorText(e)); }
  }, [id]);

  const active = job?.status === "running" || job?.status === "queued";
  useEffect(() => {
    // First load; later loads come from the interval below.
    void poll();
  }, [poll]);
  useEffect(() => {
    if (job && !active) return;
    const t = setInterval(() => void poll(), 1500);
    return () => clearInterval(t);
  }, [active, job, poll]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs, follow]);

  if (error && !job) return <ErrorNote message={error} onRetry={poll} />;
  if (!job) return <Card><LoadingRows rows={6} /></Card>;

  const shown = logs.filter((l) => level === "all" || (level === "warn" ? l.level !== "info" : l.level === "error"));
  const logText = logs.map((l) => `${l.created_at} ${l.level.toUpperCase()} ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ""}`).join("\n");
  const href = jobResultHref(job);
  const source = job.ref_id && SOURCE[job.kind]?.(job.ref_id);

  const act = async (action: "cancel" | "retry") => {
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/jobs/${id}/${action}`, { method: "POST" });
      if (action === "retry") router.push(`/runs/${res.job.id}`);
      else { toast.success("Cancel requested", "The job stops after its current page."); void poll(); }
    } catch (e) { toast.error(`Could not ${action}`, errorText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        title={job.title}
        description={<span className="inline-flex flex-wrap items-center gap-2"><JobStatusBadge status={job.status} /><Badge>{JOB_KIND_LABEL[job.kind] ?? job.kind}</Badge><span>started by {job.trigger} · {dateTime(job.created_at)}</span></span>}
        actions={<>
          <Link prefetch={false} href="/runs"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Runs</Button></Link>
          {active && <Button variant="secondary" icon={<Ban className="size-4" />} loading={busy} onClick={() => void act("cancel")}>Cancel</Button>}
          {(job.status === "failed" || job.status === "cancelled") && <Button variant="secondary" icon={<RotateCcw className="size-4" />} loading={busy} onClick={() => void act("retry")}>Run again</Button>}
          {href && !active && <Link prefetch={false} href={href}><Button icon={<ArrowRight className="size-4" />}>Open result</Button></Link>}
        </>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {job.status === "running" && (
            <Card className="p-4">
              <div className="flex items-center justify-between text-sm"><span>{job.progress.label ?? "Working…"}</span>{job.progress.total ? <span className="text-muted tabular-nums">{job.progress.done ?? 0} / {job.progress.total}</span> : null}</div>
              <Progress className="mt-2" label="Progress" value={job.progress.total ? job.progress.done ?? 0 : null} max={job.progress.total ?? 100} />
              {job.progress.rows !== undefined && <p className="mt-1.5 text-xs text-muted">{plural(job.progress.rows, "row")} so far</p>}
            </Card>
          )}
          {(() => {
            const d = job.result?.diagnosis as { title: string } | null | undefined;
            const runId = typeof job.result?.runId === "string" ? job.result.runId : null;
            if (d && runId) return <Callout tone={job.status === "failed" ? "danger" : "warning"} title={d.title} action={<Link prefetch={false} href={`/history/${runId}`}><Button size="sm" variant="secondary">Open the failure report</Button></Link>}>{job.error ?? "The run finished, but something needs a look."}</Callout>;
            return job.error ? <Callout tone="danger" title={job.status === "cancelled" ? "Cancelled" : "Failed"}>{job.error}</Callout> : null;
          })()}

          <Card>
            <CardHeader
              title="Log"
              description={active ? "Updates live." : `${logs.length} lines`}
              actions={<div className="flex items-center gap-2">
                <FilterChips label="Log level" value={level} onChange={setLevel} options={[{ value: "all", label: "All" }, { value: "warn", label: "Warnings" }, { value: "error", label: "Errors" }]} />
                <CopyButton text={logText} />
                <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(logText)}`} download={`run-${id.slice(0, 8)}.log`} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text" aria-label="Download log" title="Download log"><Download className="size-4" /></a>
              </div>}
            />
            <div ref={box} onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }} className="scroll-thin max-h-[60vh] overflow-auto bg-surface-2/40 p-3 font-mono text-xs leading-relaxed">
              {shown.length === 0 ? <p className="text-muted">{active ? "Waiting for the first log line…" : "No log lines."}</p> : shown.map((l) => (
                <div key={l.id} className="flex gap-3 py-0.5">
                  <span className="shrink-0 text-muted tabular-nums">{new Date(l.created_at).toLocaleTimeString("en-IN", { hour12: false })}</span>
                  <span className={cn("w-11 shrink-0 font-semibold uppercase", l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-muted")}>{l.level}</span>
                  <span className="min-w-0 break-words">{l.message}{l.data && <span className="text-muted"> {JSON.stringify(l.data)}</span>}</span>
                </div>
              ))}
            </div>
            {!follow && active && <div className="border-t border-border p-2 text-center"><Button size="sm" variant="ghost" onClick={() => setFollow(true)}>Jump to latest</Button></div>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-4">
            <KeyValue items={[
              { label: "Job ID", value: <span className="font-mono text-xs">{job.id}</span> },
              { label: "Started", value: dateTime(job.started_at) },
              { label: "Finished", value: dateTime(job.finished_at) },
              { label: "Took", value: duration(job.duration_ms) },
              { label: "Attempts", value: `${job.attempts} of ${job.max_attempts}` },
              { label: "Waits until", value: dateTime(job.run_after), hidden: job.status !== "queued" },
              { label: "Source", value: source ? <Link prefetch={false} href={source} className="text-accent hover:underline">Open</Link> : "—" },
            ]} />
          </Card>
          <Card>
            <details>
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Input</summary>
              <pre className="scroll-thin max-h-80 overflow-auto border-t border-border p-3 font-mono text-[11px]">{JSON.stringify(job.input, null, 2)}</pre>
            </details>
            {job.result && (
              <details className="border-t border-border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Result</summary>
                <pre className="scroll-thin max-h-80 overflow-auto border-t border-border p-3 font-mono text-[11px]">{JSON.stringify(job.result, null, 2)}</pre>
              </details>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><RunDetail id={id} /></Suspense>;
}

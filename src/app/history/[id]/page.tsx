"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, EyeOff, GitCompareArrows, ListChecks, Repeat, Table2, Trash2 } from "lucide-react";
import { RunCompare } from "@/components/run-compare";
import type { Task } from "@/server/repo/scrapes";
import { ConfirmDialog } from "@/components/dialog";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, ErrorNote, LoadingRows, Tabs } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<{ run: RunView }>(`/api/runs/${id}`);
  const task = useApi<{ task: Task }>(data?.run.recipe_id ? `/api/tasks/${data.run.recipe_id}` : null);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"data" | "compare">("data");
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Card><LoadingRows /></Card>;
  const run = data.run;

  const runAgain = async () => {
    if (!run.recipe_id) { router.push(`/scrape?url=${encodeURIComponent(run.url)}`); return; }
    setRunning(true);
    try {
      const { job } = await api<{ job: { id: string } }>(`/api/tasks/${run.recipe_id}/run?wait=0`, { method: "POST" });
      router.push(`/runs/${job.id}`);
    } catch (e) { toast.error("Could not start", errorText(e)); setRunning(false); }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link prefetch={false} href="/history" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Data</Link>
          <p className="mt-1 text-sm text-muted">
            {task.data ? <>From task <Link prefetch={false} href={`/tasks/${task.data.task.id}`} className="font-medium text-accent hover:underline">{task.data.task.name}</Link> · </> : run.recipe_id ? (task.loading ? "" : "From a deleted task · ") : "One-off scrape · "}
            {dateTime(run.created_at)}
            {run.private && <Badge className="ml-2"><EyeOff className="size-3" />private: kept in memory for an hour, never saved</Badge>}
          </p>
        </div>
        <div className="flex gap-2">
          {task.data && <Link prefetch={false} href={`/tasks/${task.data.task.id}`}><Button size="sm" variant="secondary" icon={<ListChecks className="size-4" />}>Task</Button></Link>}
          <Button size="sm" variant="secondary" icon={<Repeat className="size-4" />} loading={running} onClick={runAgain}>Run again</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Delete</Button>
        </div>
      </div>
      {run.recipe_id && !run.private && (
        <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: "data", label: "Data", icon: <Table2 className="size-4" /> }, { value: "compare", label: "Changes since earlier run", icon: <GitCompareArrows className="size-4" /> }]} />
      )}
      {tab === "compare" ? <RunCompare runId={run.id} /> : <ScrapeResultView run={run} />}
      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} title="Delete this result?" body="The scraped rows are removed from Data."
        onConfirm={async () => {
          try { await api(`/api/runs/${id}`, { method: "DELETE" }); toast.success("Result deleted"); router.push("/history"); }
          catch (e) { toast.error("Could not delete", errorText(e)); setDeleting(false); }
        }} />
    </>
  );
}

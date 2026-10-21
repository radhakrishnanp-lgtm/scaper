"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Repeat, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/dialog";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { useToast } from "@/components/toast";
import { Button, Card, ErrorNote, LoadingRows } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data, error, reload } = useApi<{ run: RunView & { recipe_id: string | null } }>(`/api/runs/${id}`);
  const [deleting, setDeleting] = useState(false);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Card><LoadingRows /></Card>;
  const run = data.run;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/history" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />History</Link>
        <div className="flex gap-2">
          <Link href={run.recipe_id ? `/scrape?recipe=${run.recipe_id}` : `/scrape?url=${encodeURIComponent(run.url)}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-card hover:bg-surface-2"><Repeat className="size-4" />Run again</Link>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Delete</Button>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted">Scraped {dateTime(run.created_at)}</p>
      <ScrapeResultView run={run} />
      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} title="Delete this result?" body="The scraped data will be removed from History."
        onConfirm={async () => {
          try { await api(`/api/runs/${id}`, { method: "DELETE" }); toast.success("Result deleted"); router.push("/history"); }
          catch (e) { toast.error("Could not delete", errorText(e)); setDeleting(false); }
        }} />
    </>
  );
}

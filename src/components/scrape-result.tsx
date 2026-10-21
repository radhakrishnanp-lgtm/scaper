"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, Radar, ShieldAlert, Wand2 } from "lucide-react";
import type { Field as FieldSpec } from "@/lib/schemas";
import type { ScrapeResult } from "@/lib/types";
import { cn } from "@/lib/cn";
import { hostOf } from "@/lib/format";
import { DataTable } from "./data-table";
import { Badge, Button, Card, EmptyState } from "./ui";

export type RunView = {
  id: string; url: string; final_url: string | null; status: "ok" | "error" | "blocked"; error: string | null;
  duration_ms: number; row_count: number; result: ScrapeResult | null; created_at: string;
};

export function ScrapeResultView({ run, onUseSelectors }: { run: RunView; onUseSelectors?: (s: { itemSelector: string; fields: FieldSpec[] }) => void }) {
  const [tab, setTab] = useState(0);
  if (run.status !== "ok" || !run.result) {
    const blocked = run.status === "blocked";
    return (
      <Card className="p-5">
        <div className="flex gap-3" role="alert">
          {blocked ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />}
          <div className="min-w-0">
            <p className="font-semibold">{blocked ? "The site didn't allow this" : "The scrape failed"}</p>
            <p className="mt-1 text-sm break-words text-muted">{run.error}</p>
          </div>
        </div>
      </Card>
    );
  }
  const r = run.result;
  const ds = r.datasets[tab] ?? r.datasets[0];
  const watchHref = `/watchers?new=1&url=${encodeURIComponent(run.final_url ?? run.url)}&name=${encodeURIComponent(r.title?.slice(0, 80) || hostOf(run.url))}`;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{r.title || hostOf(run.url)}</h2>
          <a href={r.finalUrl} target="_blank" rel="noreferrer noopener" className="block truncate text-sm text-accent hover:underline">{r.finalUrl}</a>
          <p className="mt-1 text-xs text-muted">{(run.duration_ms / 1000).toFixed(1)}s · {r.datasets.length} dataset{r.datasets.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={watchHref} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-card hover:bg-surface-2"><Radar className="size-4" />Watch page</Link>
          {ds && <>
            <a href={`/api/runs/${run.id}/export?format=csv&dataset=${tab}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-card hover:bg-surface-2"><Download className="size-4" />CSV</a>
            <a href={`/api/runs/${run.id}/export?format=json&dataset=${tab}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-card hover:bg-surface-2"><Download className="size-4" />JSON</a>
          </>}
        </div>
      </div>

      {r.notes.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-warning-soft/40 px-5 py-3 text-sm">
          {r.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}

      {r.screenshot && (
        <details className="border-b border-border px-5 py-3">
          <summary className="cursor-pointer text-sm font-medium">Screenshot</summary>
          {/* eslint-disable-next-line @next/next/no-img-element -- inline base64 screenshot */}
          <img src={`data:image/jpeg;base64,${r.screenshot}`} alt={`Screenshot of ${r.title}`} className="mt-3 w-full rounded-lg border border-border" />
        </details>
      )}

      {r.suggestions && r.suggestions.length > 0 && onUseSelectors && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <Wand2 className="size-4 text-accent" aria-hidden />
          <span className="text-sm text-muted">Found repeated items. Turn them into an editable selector recipe:</span>
          {r.suggestions.map((s, i) => (
            <Button key={i} size="sm" variant="secondary" onClick={() => onUseSelectors({ itemSelector: s.itemSelector, fields: s.fields.map((f) => ({ ...f, multiple: false })) })}>
              List {i + 1} · {s.count} items
            </Button>
          ))}
        </div>
      )}

      {r.datasets.length > 1 && (
        <div role="tablist" aria-label="Datasets" className="flex gap-1 overflow-x-auto border-b border-border px-3 pt-2">
          {r.datasets.map((d, i) => (
            <button key={i} role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
              className={cn("h-10 shrink-0 border-b-2 px-3 text-sm font-medium whitespace-nowrap", i === tab ? "border-accent text-accent" : "border-transparent text-muted hover:text-text")}>
              {d.name} <Badge className="ml-1">{d.rows.length}</Badge>
            </button>
          ))}
        </div>
      )}

      {ds && ds.rows.length > 0 ? <DataTable key={`${run.id}-${tab}`} dataset={ds} /> : (
        <EmptyState icon={<AlertTriangle className="size-5" />} title="No data found">
          The page loaded but nothing matched. If the site builds its content with JavaScript, use Browser mode. Otherwise try Auto mode or adjust your selectors.
        </EmptyState>
      )}

      {Object.keys(r.meta).length > 0 && (
        <details className="border-t border-border px-5 py-3">
          <summary className="cursor-pointer text-sm font-medium">Page details</summary>
          <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[160px_1fr]">
            {Object.entries(r.meta).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words">{v === null ? "—" : String(v)}</dd></div>
            ))}
          </dl>
        </details>
      )}
    </Card>
  );
}

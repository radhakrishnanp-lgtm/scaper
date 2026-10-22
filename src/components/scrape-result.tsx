"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileDown, Gauge, Layers, MinusCircle, PlusCircle, Radar, ShieldAlert, Wand2, XCircle } from "lucide-react";
import type { ScrapeRun } from "@/server/repo/scrapes";
import type { Field } from "@/lib/schemas";
import { duration, hostOf, plural, timeAgo } from "@/lib/format";
import { DataTable } from "./data-table";
import { RunStatusBadge } from "./status";
import { Badge, Button, Callout, Card, EmptyState, KeyValue, Tabs } from "./ui";

export type RunView = ScrapeRun;

/** Everything one run produced: datasets, pages visited, data-quality checks, new/removed rows and files. */
export function ScrapeResultView({ run, onUseSelectors, actions }: {
  run: RunView; onUseSelectors?: (s: { itemSelector: string; fields: Field[] }) => void; actions?: React.ReactNode;
}) {
  const r = run.result;
  const [view, setView] = useState("data");
  const [tab, setTab] = useState(() => {
    const i = r?.datasets.findIndex((d) => !["Links", "Images", "Headings"].includes(d.name)) ?? 0;
    return Math.max(0, i);
  });
  if (!r) {
    const blocked = run.status === "blocked";
    return (
      <Card className="p-5">
        <div className="flex gap-3" role="alert">
          {blocked ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />}
          <div className="min-w-0">
            <p className="font-semibold">{blocked ? "The site didn't allow this" : run.status === "cancelled" ? "Cancelled before any page finished" : "The scrape failed"}</p>
            <p className="mt-1 text-sm break-words text-muted">{run.error}</p>
            {blocked && <p className="mt-2 text-xs text-muted">Scaper never solves CAPTCHAs or disguises itself. Try a longer interval, the site&apos;s official API, or check the page in your own browser.</p>}
          </div>
        </div>
      </Card>
    );
  }
  const ds = r.datasets[tab] ?? r.datasets[0];
  const watchHref = `/watchers/new?url=${encodeURIComponent(run.final_url ?? run.url)}&name=${encodeURIComponent(r.title?.slice(0, 80) || hostOf(run.url))}`;
  const failedPages = r.pages?.filter((p) => p.status !== "ok").length ?? 0;
  const views = [
    { value: "data", label: "Data", count: ds?.rows.length ?? 0 },
    { value: "changes", label: "New & removed", count: r.monitor ? r.monitor.added + r.monitor.removed : null, hidden: !r.monitor },
    { value: "pages", label: "Pages", count: r.pages?.length ?? null, hidden: !r.pages?.length },
    { value: "quality", label: "Quality", count: r.quality?.issues.length || null, hidden: !r.quality },
    { value: "details", label: "Details" },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold">{r.title || hostOf(run.url)}</h2>
            <RunStatusBadge status={run.status} />
          </div>
          <a href={r.finalUrl} target="_blank" rel="noreferrer noopener" className="block truncate text-sm text-accent hover:underline">{r.finalUrl}</a>
          <p className="mt-1 text-xs text-muted">
            {plural(run.row_count, "row")} · {plural(run.page_count, "page")}{failedPages ? <span className="text-warning"> ({failedPages} failed)</span> : null} · {duration(run.duration_ms)} · {run.mode} · {timeAgo(run.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions}
          <Link href={watchHref}><Button size="sm" variant="secondary" icon={<Radar className="size-4" />}>Watch page</Button></Link>
        </div>
      </div>

      {r.notes.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-warning-soft/40 px-5 py-3 text-sm">
          {r.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      {run.status === "partial" && run.error && <div className="border-b border-border px-5 py-3"><Callout tone="warning" title="Some pages failed">{run.error}</Callout></div>}

      {r.suggestions && r.suggestions.length > 0 && onUseSelectors && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <Wand2 className="size-4 text-accent" aria-hidden />
          <span className="text-sm text-muted">Found repeated items. Turn them into editable selectors:</span>
          {r.suggestions.map((s, i) => (
            <Button key={i} size="sm" variant="secondary" onClick={() => onUseSelectors({ itemSelector: s.itemSelector, fields: s.fields.map((f) => ({ ...f, multiple: false, transforms: [], required: false })) })}>
              List {i + 1} · {s.count} items
            </Button>
          ))}
        </div>
      )}

      <Tabs value={view} onChange={setView} tabs={views} className="px-3" />

      {view === "data" && (
        <>
          {r.datasets.length > 1 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
              {r.datasets.map((d, i) => (
                <button key={i} onClick={() => setTab(i)} className={i === tab ? "inline-flex h-8 items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3 text-xs font-medium text-accent" : "inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-muted hover:text-text"}>
                  <Layers className="size-3.5" />{d.name}<span className="tabular-nums opacity-80">{d.rows.length}</span>
                </button>
              ))}
            </div>
          )}
          {ds && ds.rows.length > 0 ? (
            <DataTable
              key={`${run.id}-${tab}`}
              dataset={ds}
              fill={tab === 0 || ds === r.datasets[0] ? r.quality?.fill : undefined}
              exportHref={(f) => `/api/runs/${run.id}/export?format=${f}&dataset=${tab}`}
              fileName={`${hostOf(run.url)}-${ds.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
            />
          ) : (
            <EmptyState icon={<AlertTriangle className="size-5" />} title="No data found">
              The page loaded but nothing matched. If the site builds its content with JavaScript, use Browser mode. Otherwise try Auto mode or adjust your selectors.
            </EmptyState>
          )}
        </>
      )}

      {view === "changes" && r.monitor && (
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap gap-3 text-sm">
            <Badge tone="success"><PlusCircle className="size-3" />{r.monitor.added} new</Badge>
            <Badge tone="danger"><MinusCircle className="size-3" />{r.monitor.removed} removed</Badge>
            <span className="text-muted">compared with the previous successful run</span>
          </div>
          {r.monitor.addedRows.length > 0 && <div className="overflow-hidden rounded-xl border border-border"><p className="bg-success-soft/40 px-4 py-2 text-sm font-medium">New rows</p><DataTable dataset={{ name: "New", columns: Object.keys(r.monitor.addedRows[0]!), rows: r.monitor.addedRows }} compact /></div>}
          {r.monitor.removedRows.length > 0 && <div className="overflow-hidden rounded-xl border border-border"><p className="bg-danger-soft/40 px-4 py-2 text-sm font-medium">Removed rows</p><DataTable dataset={{ name: "Removed", columns: Object.keys(r.monitor.removedRows[0]!), rows: r.monitor.removedRows }} compact /></div>}
          {!r.monitor.added && !r.monitor.removed && <p className="text-sm text-muted">Same rows as last time.</p>}
        </div>
      )}

      {view === "pages" && r.pages && (
        <div className="scroll-thin max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left"><tr><th className="px-4 py-2 font-medium">Page</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Rows</th><th className="px-3 py-2 text-right font-medium">Time</th><th className="px-3 py-2 text-right font-medium">Depth</th></tr></thead>
            <tbody className="divide-y divide-border">
              {r.pages.map((p, i) => (
                <tr key={i}>
                  <td className="max-w-md px-4 py-2"><a href={p.url} target="_blank" rel="noreferrer noopener" className="block truncate text-accent hover:underline">{p.url}</a>{p.error && <span className="block text-xs text-danger">{p.error}</span>}</td>
                  <td className="px-3 py-2">{p.status === "ok" ? <CheckCircle2 className="size-4 text-success" aria-label="ok" /> : p.status === "blocked" ? <ShieldAlert className="size-4 text-warning" aria-label="blocked" /> : <XCircle className="size-4 text-danger" aria-label={p.status} />}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.rows}</td>
                  <td className="px-3 py-2 text-right text-muted tabular-nums">{duration(p.ms)}</td>
                  <td className="px-3 py-2 text-right text-muted tabular-nums">{p.depth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "quality" && r.quality && (
        <div className="space-y-4 p-5">
          {r.quality.issues.length ? (
            <Callout tone="warning" icon={<Gauge className="size-4 text-warning" />} title="This data may be incomplete">
              <ul className="list-disc pl-4">{r.quality.issues.map((x) => <li key={x}>{x}</li>)}</ul>
            </Callout>
          ) : <Callout tone="success" icon={<CheckCircle2 className="size-4 text-success" />} title="Passed the quality checks" />}
          <div className="space-y-2">
            <p className="text-sm font-medium">How full each column is</p>
            {Object.entries(r.quality.fill).map(([c, pct]) => (
              <div key={c} className="grid grid-cols-[minmax(100px,200px)_1fr_48px] items-center gap-3 text-sm">
                <span className="truncate text-muted">{c}</span>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className={pct < 50 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-accent"} style={{ width: `${pct}%` }} /></div>
                <span className="text-right tabular-nums">{pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "details" && (
        <div className="space-y-4 p-5">
          <KeyValue items={[
            { label: "Run ID", value: <span className="font-mono text-xs">{run.id}</span> },
            { label: "Started from", value: run.url },
            { label: "Extraction", value: run.extract.type },
            { label: "Files saved", value: r.files?.length ? <ul>{r.files.map((f) => <li key={f} className="flex items-center gap-1.5 font-mono text-xs"><FileDown className="size-3.5 text-muted" />data/{f}</li>)}</ul> : "—", hidden: !r.files?.length },
            ...Object.entries(r.meta).map(([k, v]) => ({ label: k, value: v === null ? "—" : String(v) })),
          ]} />
          {r.screenshot && (
            // eslint-disable-next-line @next/next/no-img-element -- inline base64 screenshot
            <img src={`data:image/jpeg;base64,${r.screenshot}`} alt={`Screenshot of ${r.title}`} className="w-full rounded-lg border border-border" />
          )}
        </div>
      )}
    </Card>
  );
}

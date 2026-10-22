"use client";

import { useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { Cell } from "@/lib/types";
import { DataTable } from "./data-table";
import { Badge, Card, CardHeader, EmptyState, ErrorNote, FilterChips, LoadingRows, Select, TagInput } from "./ui";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Row = Record<string, Cell>;
type Compare = {
  base: { id: string; created_at: string; rows: number } | null; current?: { id: string; created_at: string; rows: number };
  choices: { id: string; created_at: string; rows: number }[]; columns: string[]; key: string[];
  counts?: { added: number; removed: number; changed: number };
  added: Row[]; removed: Row[]; changed: { key: string; before: Row; after: Row; columns: string[] }[];
};
type Show = "changed" | "added" | "removed";

const text = (v: Cell | undefined) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** What changed between this run and an earlier one of the same task: new rows, gone rows and changed values. */
export function RunCompare({ runId }: { runId: string }) {
  const [base, setBase] = useState("");
  const [key, setKey] = useState<string[] | null>(null);
  const [show, setShow] = useState<Show>("changed");
  const qs = new URLSearchParams();
  if (base) qs.set("with", base);
  if (key?.length) qs.set("key", key.join(","));
  const { data, error, loading, reload } = useApi<Compare>(`/api/runs/${runId}/compare?${qs}`);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <Card><LoadingRows rows={5} /></Card>;
  if (!data.base) return <Card><EmptyState icon={<GitCompareArrows className="size-5" />} title="Nothing to compare yet">The comparison appears after this task has another run with rows.</EmptyState></Card>;
  const c = data.counts!;
  const keyNow = key ?? data.key;
  const cols = data.columns;

  return (
    <Card>
      <CardHeader title="Changes since an earlier run" description={`${data.base.rows.toLocaleString("en-IN")} rows ${timeAgo(data.base.created_at)} → ${data.current!.rows.toLocaleString("en-IN")} rows now`} />
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-end lg:justify-between">
        <FilterChips label="Show" value={show} onChange={setShow} options={[
          { value: "changed", label: "Changed", count: c.changed }, { value: "added", label: "New", count: c.added }, { value: "removed", label: "Gone", count: c.removed },
        ]} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm"><span className="mb-1 block text-xs text-muted">Compare with</span>
            <Select aria-label="Compare with run" className="h-9 w-56" value={base || data.base.id} onChange={(e) => setBase(e.target.value)}>
              {data.choices.map((r) => <option key={r.id} value={r.id}>{dateTime(r.created_at)} ({r.rows} rows)</option>)}
            </Select>
          </label>
          <div className="w-64"><TagInput label="Match rows by" value={keyNow} onChange={setKey} suggestions={cols} placeholder="All columns" max={5} /></div>
        </div>
      </div>
      {!keyNow.length && <p className="border-b border-border px-4 py-2 text-xs text-muted">Rows are matched on all columns, so an edit shows as one gone and one new row. Pick a column that identifies an item (like its link) to see changed values.</p>}
      {loading && <LoadingRows rows={3} />}
      {!loading && show === "changed" && (
        c.changed ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">Item</th><th className="px-3 py-2 font-medium">Column</th><th className="px-3 py-2 font-medium">Before</th><th className="px-3 py-2 font-medium">Now</th></tr></thead>
              <tbody className="divide-y divide-border">
                {data.changed.flatMap((r) => r.columns.map((col, i) => (
                  <tr key={`${r.key}-${col}`}>
                    {i === 0 && <td rowSpan={r.columns.length} className="max-w-xs px-4 py-2 align-top"><span className="line-clamp-2 break-all">{keyNow.map((k) => text(r.after[k])).join(" · ")}</span></td>}
                    <td className="px-3 py-2"><Badge>{col}</Badge></td>
                    <td className="max-w-xs px-3 py-2 break-words text-danger line-through decoration-danger/40">{text(r.before[col]).slice(0, 300)}</td>
                    <td className="max-w-xs px-3 py-2 break-words text-success">{text(r.after[col]).slice(0, 300)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-4 text-sm text-muted">{keyNow.length ? "No values changed." : "Pick a column to match rows by."}</p>
      )}
      {!loading && show !== "changed" && (
        (show === "added" ? data.added : data.removed).length
          ? <DataTable dataset={{ name: show === "added" ? "New rows" : "Gone rows", columns: cols, rows: show === "added" ? data.added : data.removed }} compact />
          : <p className="p-4 text-sm text-muted">{show === "added" ? "No new rows." : "No rows are gone."}</p>
      )}
    </Card>
  );
}

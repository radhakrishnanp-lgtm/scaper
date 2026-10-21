"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { Cell, Dataset } from "@/lib/types";
import { Input } from "./ui";

const isUrl = (v: Cell) => typeof v === "string" && /^https?:\/\//.test(v);
const PAGE = 50;

function CellView({ v }: { v: Cell }) {
  if (v === null || v === "") return <span className="text-muted">—</span>;
  if (isUrl(v)) {
    const s = String(v);
    if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(s)) {
      // eslint-disable-next-line @next/next/no-img-element -- remote images from scraped sites; next/image would need every host allow-listed
      return <a href={s} target="_blank" rel="noreferrer noopener"><img src={s} alt="" loading="lazy" className="h-10 w-10 rounded object-cover" /></a>;
    }
    return <a href={s} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline break-all">{s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a>;
  }
  return <span className="break-words">{String(v)}</span>;
}

/** Sortable, filterable table. On small screens each row becomes a card. */
export function DataTable({ dataset }: { dataset: Dataset }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    let r = dataset.rows;
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter((row) => Object.values(row).some((v) => v !== null && String(v).toLowerCase().includes(needle)));
    }
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = a[sort.col];
        const y = b[sort.col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
      });
    }
    return r;
  }, [dataset.rows, q, sort]);

  const shown = rows.slice(0, page * PAGE);
  const toggleSort = (col: string) => setSort((s) => (s?.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Filter rows" className="h-10 pl-9" aria-label="Filter rows" />
        </div>
        <span className="text-sm text-muted tabular-nums">{rows.length} of {dataset.rows.length} rows</span>
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="border-y border-border bg-surface-2/60 text-left">
            <tr>
              {dataset.columns.map((c) => (
                <th key={c} scope="col" className="px-4 py-2.5 font-medium whitespace-nowrap" aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button onClick={() => toggleSort(c)} className="inline-flex items-center gap-1 hover:text-accent">
                    {c}
                    {sort?.col === c && (sort.dir === 1 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r, i) => (
              <tr key={i} className="hover:bg-surface-2/50">
                {dataset.columns.map((c) => <td key={c} className="max-w-md px-4 py-2.5 align-top"><CellView v={r[c] ?? null} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border border-t border-border md:hidden">
        {shown.map((r, i) => (
          <li key={i} className="space-y-1.5 px-5 py-3">
            {dataset.columns.map((c) => (
              <div key={c} className="grid grid-cols-[96px_1fr] gap-2 text-sm">
                <span className="truncate text-muted">{c}</span>
                <CellView v={r[c] ?? null} />
              </div>
            ))}
          </li>
        ))}
      </ul>

      {shown.length < rows.length && (
        <div className="border-t border-border p-3 text-center">
          <button onClick={() => setPage((p) => p + 1)} className="h-10 rounded-lg px-4 text-sm font-medium text-accent hover:bg-accent-soft">Show {Math.min(PAGE, rows.length - shown.length)} more</button>
        </div>
      )}
    </div>
  );
}

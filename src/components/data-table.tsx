"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ClipboardCopy, Columns3, Download, Rows2, Rows4, WrapText } from "lucide-react";
import type { Cell, Dataset } from "@/lib/types";
import { toCsv } from "@/lib/csv";
import { cn } from "@/lib/cn";
import { Dialog } from "./dialog";
import { Menu, Popover, type MenuItem } from "./menu";
import { useToast } from "./toast";
import { Badge, Button, Checkbox, IconButton, KeyValue, SearchInput, Select } from "./ui";

const isUrl = (v: Cell) => typeof v === "string" && /^https?:\/\//.test(v);
const isImage = (s: string) => /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(s) || /\/images?\//i.test(s) && /\.(png|jpe?g|webp)/i.test(s);

function CellView({ v, wrap }: { v: Cell; wrap: boolean }) {
  if (v === null || v === "" || v === undefined) return <span className="text-muted/60">—</span>;
  if (typeof v === "boolean") return <Badge tone={v ? "success" : "neutral"}>{v ? "yes" : "no"}</Badge>;
  if (typeof v === "number") return <span className="tabular-nums">{v.toLocaleString("en-IN", { maximumFractionDigits: 4 })}</span>;
  if (isUrl(v)) {
    const s = String(v);
    if (isImage(s)) {
      // eslint-disable-next-line @next/next/no-img-element -- remote images from scraped sites; next/image would need every host allow-listed
      return <a href={s} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}><img src={s} alt="" loading="lazy" className="h-10 w-10 rounded object-cover" /></a>;
    }
    return <a href={s} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className={cn("text-accent hover:underline", wrap ? "break-all" : "block max-w-72 truncate")}>{s.replace(/^https?:\/\/(www\.)?/, "")}</a>;
  }
  const s = String(v);
  return <span className={cn(wrap ? "break-words whitespace-pre-wrap" : "block max-w-80 truncate")} title={!wrap && s.length > 60 ? s : undefined}>{s}</span>;
}

type Sort = { col: string; dir: 1 | -1 } | null;
const compare = (a: Cell | undefined, b: Cell | undefined) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
};

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Data grid for scraped rows: search, sort, choose columns, density and wrapping,
 * select rows to copy or export, and open any row to see every field.
 * `exportHref` (server export) is used for full-file downloads; selections export in the browser.
 */
export function DataTable({ dataset, exportHref, fill, fileName = "data", compact }: {
  dataset: Dataset; exportHref?: (format: "csv" | "json" | "xlsx" | "ndjson") => string; fill?: Record<string, number>; fileName?: string; compact?: boolean;
}) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dense, setDense] = useState(Boolean(compact));
  const [wrap, setWrap] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);

  const columns = dataset.columns.filter((c) => !hidden.has(c));
  const indexed = useMemo(() => dataset.rows.map((r, i) => ({ r, i })), [dataset.rows]);
  const rows = useMemo(() => {
    let out = indexed;
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter(({ r }) => Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(needle)));
    }
    if (sort) out = [...out].sort((a, b) => compare(a.r[sort.col], b.r[sort.col]) * sort.dir);
    return out;
  }, [indexed, q, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * pageSize, current * pageSize + pageSize);
  const allFilteredSelected = rows.length > 0 && rows.every((x) => selected.has(x.i));

  const toggleSort = (col: string) => setSort((s) => (s?.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  const chosen = () => (selected.size ? rows.filter((x) => selected.has(x.i)) : rows).map((x) => x.r);
  const copy = async () => {
    const data = chosen();
    const tsv = [columns.join("\t"), ...data.map((r) => columns.map((c) => String(r[c] ?? "").replace(/[\t\n]+/g, " ")).join("\t"))].join("\n");
    try { await navigator.clipboard.writeText(tsv); toast.success(`Copied ${data.length} row${data.length === 1 ? "" : "s"}`, "Paste into Excel or Google Sheets."); }
    catch { toast.error("Could not copy", "Your browser blocked clipboard access."); }
  };
  const exportItems: MenuItem[] = [
    ...(exportHref && !selected.size && !q
      ? [{ heading: "Whole dataset" } as MenuItem, ...(["csv", "xlsx", "json", "ndjson"] as const).map((f) => ({ label: { csv: "CSV", xlsx: "Excel (.xlsx)", json: "JSON", ndjson: "NDJSON (one row per line)" }[f], href: exportHref(f), download: true }) as MenuItem)]
      : []),
    { heading: selected.size ? `${selected.size} selected rows` : q ? `${rows.length} filtered rows` : "In the browser" },
    { label: "CSV", onSelect: () => download(`${fileName}.csv`, "﻿" + toCsv(columns, chosen()), "text/csv") },
    { label: "JSON", onSelect: () => download(`${fileName}.json`, JSON.stringify(chosen().map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))), null, 2), "application/json") },
  ];

  const pad = dense ? "px-3 py-1.5" : "px-4 py-2.5";
  const openRow = open !== null ? dataset.rows[open] : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="Filter rows" className="w-full sm:w-64" />
        <span className="text-sm text-muted tabular-nums">{rows.length === dataset.rows.length ? `${rows.length} rows` : `${rows.length} of ${dataset.rows.length} rows`}</span>
        {selected.size > 0 && (
          <span className="flex items-center gap-2">
            <Badge tone="accent">{selected.size} selected</Badge>
            <button className="text-xs text-muted hover:text-text" onClick={() => setSelected(new Set())}>Clear</button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label={dense ? "Comfortable rows" : "Compact rows"} onClick={() => setDense(!dense)}>{dense ? <Rows2 className="size-4" /> : <Rows4 className="size-4" />}</IconButton>
          <IconButton label={wrap ? "Truncate long text" : "Wrap long text"} onClick={() => setWrap(!wrap)} className={wrap ? "text-accent" : undefined}><WrapText className="size-4" /></IconButton>
          <Popover
            label="Columns"
            panelClassName="w-64"
            trigger={(p) => <button {...p} type="button" title="Choose columns" aria-label="Choose columns" className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><Columns3 className="size-4" /></button>}
          >
            {() => (
              <div className="p-3">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-semibold">Columns</span>
                  <button className="text-accent hover:underline" onClick={() => setHidden(new Set())}>Show all</button>
                </div>
                <div className="scroll-thin max-h-72 space-y-1.5 overflow-y-auto">
                  {dataset.columns.map((c) => (
                    <div key={c} className="flex items-center justify-between gap-2">
                      <Checkbox label={c} checked={!hidden.has(c)} onChange={(on) => setHidden((h) => { const n = new Set(h); if (on) n.delete(c); else n.add(c); return n; })} />
                      {fill?.[c] !== undefined && <span className={cn("text-[11px] tabular-nums", fill[c]! < 50 ? "text-warning" : "text-muted")}>{fill[c]}%</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Popover>
          <IconButton label="Copy rows (for Excel or Sheets)" onClick={copy}><ClipboardCopy className="size-4" /></IconButton>
          <Menu label="Export" items={exportItems} trigger={(p) => <Button {...p} size="sm" variant="secondary" icon={<Download className="size-4" />}>Export</Button>} />
        </div>
      </div>

      <div className="scroll-thin hidden max-h-[70vh] overflow-auto border-t border-border md:block">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-left shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="w-10 px-3">
                <Checkbox hideLabel label="Select all rows" checked={allFilteredSelected} indeterminate={selected.size > 0} onChange={(on) => setSelected(on ? new Set(rows.map((x) => x.i)) : new Set())} />
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" className={cn(pad, "font-medium whitespace-nowrap")} aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button onClick={() => toggleSort(c)} className="inline-flex items-center gap-1 hover:text-accent">
                    {c}
                    {sort?.col === c && (sort.dir === 1 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />)}
                  </button>
                  {fill?.[c] !== undefined && fill[c]! < 100 && <span className={cn("ml-1.5 text-[10px] font-normal tabular-nums", fill[c]! < 50 ? "text-warning" : "text-muted")} title={`${fill[c]}% of rows have a value`}>{fill[c]}%</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map(({ r, i }) => (
              <tr key={i} className={cn("cursor-pointer hover:bg-surface-2/60", selected.has(i) && "bg-accent-soft/30")} onClick={() => setOpen(i)}>
                <td className="px-3" onClick={(e) => e.stopPropagation()}>
                  <Checkbox hideLabel label={`Select row ${i + 1}`} checked={selected.has(i)} onChange={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(i); else n.delete(i); return n; })} />
                </td>
                {columns.map((c) => <td key={c} className={cn(pad, "align-top", typeof r[c] === "number" && "text-right")}><CellView v={r[c] ?? null} wrap={wrap} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="px-4 py-8 text-center text-sm text-muted">{q ? "No rows match the filter." : "No rows."}</p>}
      </div>

      <ul className="divide-y divide-border border-t border-border md:hidden">
        {shown.map(({ r, i }) => (
          <li key={i} className="space-y-1.5 px-4 py-3" onClick={() => setOpen(i)}>
            {columns.slice(0, 6).map((c) => (
              <div key={c} className="grid grid-cols-[96px_1fr] gap-2 text-sm">
                <span className="truncate text-muted">{c}</span>
                <CellView v={r[c] ?? null} wrap />
              </div>
            ))}
            {columns.length > 6 && <p className="text-xs text-accent">+{columns.length - 6} more fields</p>}
          </li>
        ))}
      </ul>

      {rows.length > 25 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-sm">
          <label className="flex items-center gap-2 text-muted">
            Rows per page
            <Select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} className="h-9 w-20">
              {[25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-muted tabular-nums">{current * pageSize + 1}–{Math.min(rows.length, (current + 1) * pageSize)} of {rows.length}</span>
            <Button size="sm" variant="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button>
          </div>
        </div>
      )}

      <Dialog open={openRow !== null} onClose={() => setOpen(null)} title={`Row ${open !== null ? open + 1 : ""}`} wide
        footer={<>
          <Button variant="secondary" icon={<ClipboardCopy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(JSON.stringify(openRow, null, 2)).then(() => toast.success("Copied as JSON")); }}>Copy JSON</Button>
          <Button variant="secondary" disabled={open === null || open <= 0} onClick={() => setOpen((o) => (o === null ? o : o - 1))}>Previous</Button>
          <Button disabled={open === null || open >= dataset.rows.length - 1} onClick={() => setOpen((o) => (o === null ? o : o + 1))}>Next</Button>
        </>}
      >
        {openRow && <KeyValue items={dataset.columns.map((c) => ({ label: c, value: <CellView v={openRow[c] ?? null} wrap /> }))} />}
      </Dialog>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton size="sm" label={label} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? <Check className="size-3.5 text-success" /> : <ClipboardCopy className="size-3.5" />}
    </IconButton>
  );
}

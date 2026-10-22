"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, BarChart3, Bookmark, Calendar, Check, ClipboardCopy, Columns3, Download, Hash, ImageIcon, Link2, Mail, Pin, PinOff, Rows2, Rows4, Save,
  ToggleLeft, Trash2, Type, WrapText, X,
} from "lucide-react";
import type { Cell, Dataset } from "@/lib/types";
import { toCsv } from "@/lib/csv";
import { cn } from "@/lib/cn";
import { inferType, isEmpty, profileColumn, toNumber, type ColumnProfile, type ColumnType } from "@/lib/validation";
import { api, errorText } from "@/lib/api-client";
import { Dialog } from "./dialog";
import { Menu, Popover, type MenuItem } from "./menu";
import { useToast } from "./toast";
import { Badge, Button, Checkbox, IconButton, Input, KeyValue, SearchInput } from "./ui";

const isUrl = (v: Cell) => typeof v === "string" && /^https?:\/\//.test(v);
const isImage = (s: string) => /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(s) || /\/images?\//i.test(s) && /\.(png|jpe?g|webp)/i.test(s);

const TYPE_ICON: Partial<Record<ColumnType, ReactNode>> = {
  number: <Hash className="size-3" />, url: <Link2 className="size-3" />, image: <ImageIcon className="size-3" />, date: <Calendar className="size-3" />,
  boolean: <ToggleLeft className="size-3" />, email: <Mail className="size-3" />, text: <Type className="size-3" />,
};
const TYPE_LABEL: Record<ColumnType, string> = { number: "Number", url: "Link", image: "Image", date: "Date", boolean: "Yes / no", email: "Email", text: "Text", list: "List", json: "Object", empty: "Empty" };
const DEFAULT_WIDTH: Partial<Record<ColumnType, number>> = { number: 120, image: 84, url: 240, boolean: 96, date: 150, email: 200 };

function CellView({ v, wrap, type }: { v: Cell; wrap: boolean; type?: ColumnType }) {
  if (v === null || v === "" || v === undefined) return <span className="text-muted/60">—</span>;
  if (typeof v === "boolean") return <Badge tone={v ? "success" : "neutral"}>{v ? "yes" : "no"}</Badge>;
  if (typeof v === "number") return <span className="tabular-nums">{v.toLocaleString("en-IN", { maximumFractionDigits: 4 })}</span>;
  if (isUrl(v)) {
    const s = String(v);
    if (type === "image" || isImage(s)) {
      // eslint-disable-next-line @next/next/no-img-element -- remote images from scraped sites; next/image would need every host allow-listed
      return <a href={s} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}><img src={s} alt="" loading="lazy" className="h-10 w-10 rounded object-cover" /></a>;
    }
    return <a href={s} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className={cn("text-accent hover:underline", wrap ? "break-all" : "block truncate")}>{s.replace(/^https?:\/\/(www\.)?/, "")}</a>;
  }
  const s = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return <span className={cn(wrap ? "break-words whitespace-pre-wrap" : "block truncate", type === "number" && "tabular-nums")} title={!wrap && s.length > 40 ? s : undefined}>{s}</span>;
}

type Sort = { col: string; dir: 1 | -1 } | null;
/** A filter on one column: some text, a number range, a set of values, or only empty / only filled. */
export type ColumnFilter = { text?: string; min?: number | null; max?: number | null; values?: string[]; empty?: "empty" | "filled" };
type ViewState = { hidden: string[]; pinned: string[]; widths: Record<string, number>; sort: Sort; filters: Record<string, ColumnFilter>; q: string; dense: boolean; wrap: boolean };

const compareCells = (a: Cell | undefined, b: Cell | undefined, numeric: boolean) => {
  if (a === b) return 0;
  if (isEmpty(a ?? null)) return 1;
  if (isEmpty(b ?? null)) return -1;
  if (numeric) { const x = toNumber(a!), y = toNumber(b!); if (x !== null && y !== null) return x - y; }
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
};

function matches(v: Cell | undefined, f: ColumnFilter, numeric: boolean) {
  const val = v ?? null;
  if (f.empty === "empty" && !isEmpty(val)) return false;
  if (f.empty === "filled" && isEmpty(val)) return false;
  if (f.text && !String(val ?? "").toLowerCase().includes(f.text.toLowerCase())) return false;
  if (numeric && (f.min !== undefined && f.min !== null || f.max !== undefined && f.max !== null)) {
    const n = toNumber(val);
    if (n === null || (f.min !== null && f.min !== undefined && n < f.min) || (f.max !== null && f.max !== undefined && n > f.max)) return false;
  }
  if (f.values?.length && !f.values.includes(String(val ?? ""))) return false;
  return true;
}
const filterActive = (f: ColumnFilter | undefined) => Boolean(f && (f.text || f.values?.length || f.empty || (f.min !== null && f.min !== undefined) || (f.max !== null && f.max !== undefined)));
function filterText(c: string, f: ColumnFilter) {
  const parts: string[] = [];
  if (f.empty) parts.push(f.empty === "empty" ? "is empty" : "is filled");
  if (f.text) parts.push(`contains “${f.text}”`);
  if (f.min !== null && f.min !== undefined) parts.push(`≥ ${f.min}`);
  if (f.max !== null && f.max !== undefined) parts.push(`≤ ${f.max}`);
  if (f.values?.length) parts.push(f.values.length === 1 ? `= ${f.values[0] || "(empty)"}` : `in ${f.values.length} values`);
  return `${c} ${parts.join(", ")}`;
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fmtNum = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));

/** Everything about one column: its type and fill, number stats or top values, plus filter, sort, pin and hide. */
function ColumnPanel({ col, profile, filter, numeric, pinned, onFilter, onSort, onPin, onHide, onClose }: {
  col: string; profile: ColumnProfile; filter: ColumnFilter | undefined; numeric: boolean; pinned: boolean;
  onFilter: (f: ColumnFilter | null) => void; onSort: (dir: 1 | -1) => void; onPin: () => void; onHide: () => void; onClose: () => void;
}) {
  const f = filter ?? {};
  const topMax = Math.max(1, ...profile.top.map((t) => t.count));
  return (
    <section className="border-t border-border bg-surface-2/40 px-4 py-3" aria-label={`Column ${col}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold">{TYPE_ICON[profile.type]}{col}</span>
        <Badge>{TYPE_LABEL[profile.type]}</Badge>
        <span className={cn("text-xs tabular-nums", profile.fill < 50 ? "text-warning" : "text-muted")}>{profile.fill}% filled</span>
        <span className="text-xs tabular-nums text-muted">· {profile.distinct.toLocaleString("en-IN")} distinct{profile.unique ? " (all unique)" : ""}</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} onClick={() => onSort(1)}>Sort up</Button>
          <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} onClick={() => onSort(-1)}>Sort down</Button>
          <Button size="sm" variant="ghost" icon={pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />} onClick={onPin}>{pinned ? "Unpin" : "Pin left"}</Button>
          <Button size="sm" variant="ghost" onClick={onHide}>Hide</Button>
          <IconButton size="sm" label="Close column panel" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {numeric ? (
            <KeyValue items={[
              { label: "Min / max", value: <span className="tabular-nums">{fmtNum(profile.min)} – {fmtNum(profile.max)}</span> },
              { label: "Average", value: <span className="tabular-nums">{fmtNum(profile.mean)}</span> },
              { label: "Median", value: <span className="tabular-nums">{fmtNum(profile.median)}</span> },
            ]} />
          ) : (
            <ul className="space-y-1">
              {profile.top.slice(0, 8).map((t) => {
                const on = f.values?.includes(t.value);
                return (
                  <li key={t.value}>
                    <button type="button" onClick={() => onFilter({ ...f, values: on ? f.values!.filter((x) => x !== t.value) : [...(f.values ?? []), t.value] })}
                      className={cn("relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-left text-xs", on ? "ring-1 ring-accent" : "hover:bg-surface")}
                      aria-pressed={on}>
                      <span className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: `${(t.count / topMax) * 100}%` }} aria-hidden />
                      <span className="relative min-w-0 flex-1 truncate">{t.value || "(empty)"}</span>
                      <span className="relative tabular-nums text-muted">{t.count.toLocaleString("en-IN")}</span>
                    </button>
                  </li>
                );
              })}
              {profile.distinct > 8 && <li className="px-2 text-[11px] text-muted">Top 8 of {profile.distinct.toLocaleString("en-IN")} values. Click to filter.</li>}
            </ul>
          )}
          {profile.minLength !== null && !numeric && <p className="text-[11px] text-muted">Length {profile.minLength}–{profile.maxLength} characters</p>}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted">Filter</p>
          <Input aria-label={`${col} contains`} className="h-9 text-sm" placeholder="Contains…" value={f.text ?? ""} onChange={(e) => onFilter({ ...f, text: e.target.value || undefined })} />
          {numeric && (
            <div className="flex items-center gap-2">
              <Input aria-label={`${col} at least`} className="h-9 text-sm" inputMode="decimal" placeholder="min" value={f.min ?? ""} onChange={(e) => onFilter({ ...f, min: e.target.value === "" ? null : Number(e.target.value) })} />
              <span className="text-xs text-muted">to</span>
              <Input aria-label={`${col} at most`} className="h-9 text-sm" inputMode="decimal" placeholder="max" value={f.max ?? ""} onChange={(e) => onFilter({ ...f, max: e.target.value === "" ? null : Number(e.target.value) })} />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {(["filled", "empty"] as const).map((k) => (
              <button key={k} type="button" onClick={() => onFilter({ ...f, empty: f.empty === k ? undefined : k })} aria-pressed={f.empty === k}
                className={cn("h-8 rounded-full border px-3 text-xs", f.empty === k ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>
                {k === "filled" ? "Only filled" : "Only empty"}
              </button>
            ))}
            {filterActive(f) && <button type="button" onClick={() => onFilter(null)} className="h-8 px-2 text-xs text-accent hover:underline">Clear filter</button>}
          </div>
        </div>
      </div>
    </section>
  );
}

const ROW_H = { dense: 37, normal: 49 };
const OVERSCAN = 12;

/**
 * Data grid for scraped rows, built for big runs: typed columns with stats, per-column filters and facets,
 * sort, pin, resize and hide, saved views, virtual scrolling for 100 000 rows, selection, copy and export,
 * and a row drawer with every field.
 */
export function DataTable({ dataset, exportHref, fill, fileName = "data", compact, viewScope }: {
  dataset: Dataset; exportHref?: (format: "csv" | "json" | "xlsx" | "ndjson") => string; fill?: Record<string, number>; fileName?: string; compact?: boolean;
  /** Saves and loads named views (columns, widths, pins, filters, sort) under this key, e.g. "task:<id>". */
  viewScope?: string;
}) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<string[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [dense, setDense] = useState(Boolean(compact));
  const [wrap, setWrap] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [mobileCount, setMobileCount] = useState(30);
  const [wrapCount, setWrapCount] = useState(200);

  const types = useMemo(() => {
    const sample = dataset.rows.length > 800 ? dataset.rows.filter((_, i) => i % Math.ceil(dataset.rows.length / 800) === 0) : dataset.rows;
    return Object.fromEntries(dataset.columns.map((c) => [c, inferType(sample.map((r) => r[c] ?? null))])) as Record<string, ColumnType>;
  }, [dataset]);
  const numeric = useCallback((c: string) => types[c] === "number", [types]);
  const widthOf = useCallback((c: string) => widths[c] ?? DEFAULT_WIDTH[types[c] ?? "text"] ?? 200, [widths, types]);

  const columns = useMemo(() => {
    const visible = dataset.columns.filter((c) => !hidden.has(c));
    return [...pinned.filter((c) => visible.includes(c)), ...visible.filter((c) => !pinned.includes(c))];
  }, [dataset.columns, hidden, pinned]);

  const indexed = useMemo(() => dataset.rows.map((r, i) => ({ r, i })), [dataset.rows]);
  const rows = useMemo(() => {
    let out = indexed;
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter(({ r }) => Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(needle)));
    const active = Object.entries(filters).filter(([, f]) => filterActive(f));
    if (active.length) out = out.filter(({ r }) => active.every(([c, f]) => matches(r[c], f, numeric(c))));
    if (sort) out = [...out].sort((a, b) => compareCells(a.r[sort.col], b.r[sort.col], numeric(sort.col)) * sort.dir);
    return out;
  }, [indexed, q, filters, sort, numeric]);
  const profile = useMemo(() => (panel ? profileColumn({ ...dataset, rows: rows.map((x) => x.r) }, panel) : null), [panel, dataset, rows]);

  // Virtual scrolling: only the rows in view (plus a margin) are in the DOM.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowH = dense ? ROW_H.dense : ROW_H.normal;
  const virtual = !wrap && rows.length > 60;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const end = virtual ? Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN) : Math.min(rows.length, wrapCount);
  const shown = rows.slice(start, end);
  const allFilteredSelected = rows.length > 0 && selected.size >= rows.length && rows.every((x) => selected.has(x.i));

  // Column resizing by dragging the header edge (double-click resets).
  const startResize = (c: string, e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = widthOf(c);
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [c]: Math.max(60, Math.min(800, w0 + ev.clientX - x0)) }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const leftOf = (c: string) => { let x = 40; for (const p of columns) { if (p === c) return x; if (pinned.includes(p)) x += widthOf(p); } return x; };

  const toggleSort = (col: string) => setSort((s) => (s?.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  const chosen = () => (selected.size ? rows.filter((x) => selected.has(x.i)) : rows).map((x) => x.r);
  const copy = async () => {
    const data = chosen();
    const tsv = [columns.join("\t"), ...data.map((r) => columns.map((c) => String(r[c] ?? "").replace(/[\t\n]+/g, " ")).join("\t"))].join("\n");
    try { await navigator.clipboard.writeText(tsv); toast.success(`Copied ${data.length} row${data.length === 1 ? "" : "s"}`, "Paste into Excel or Google Sheets."); }
    catch { toast.error("Could not copy", "Your browser blocked clipboard access."); }
  };
  const activeFilters = Object.entries(filters).filter(([, f]) => filterActive(f));
  const narrowed = Boolean(q || activeFilters.length);
  const exportItems: MenuItem[] = [
    ...(exportHref && !selected.size && !narrowed
      ? [{ heading: "Whole dataset" } as MenuItem, ...(["csv", "xlsx", "json", "ndjson"] as const).map((f) => ({ label: { csv: "CSV", xlsx: "Excel (.xlsx)", json: "JSON", ndjson: "NDJSON (one row per line)" }[f], href: exportHref(f), download: true }) as MenuItem)]
      : []),
    { heading: selected.size ? `${selected.size} selected rows` : narrowed ? `${rows.length} filtered rows, visible columns` : "In the browser" },
    { label: "CSV", onSelect: () => download(`${fileName}.csv`, "﻿" + toCsv(columns, chosen()), "text/csv") },
    { label: "JSON", onSelect: () => download(`${fileName}.json`, JSON.stringify(chosen().map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))), null, 2), "application/json") },
  ];

  // Saved views.
  const [views, setViews] = useState<{ id: string; name: string; state: ViewState }[]>([]);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  useEffect(() => {
    if (!viewScope) return;
    let stop = false;
    api<{ items: { id: string; name: string; state: ViewState }[] }>(`/api/views?scope=${encodeURIComponent(viewScope)}`).then((r) => { if (!stop) setViews(r.items); }).catch(() => undefined);
    return () => { stop = true; };
  }, [viewScope]);
  const snapshot = (): ViewState => ({ hidden: [...hidden], pinned, widths, sort, filters: Object.fromEntries(activeFilters), q, dense, wrap });
  const apply = (v: { id: string; state: ViewState }) => {
    const s = v.state;
    setHidden(new Set(s.hidden ?? [])); setPinned(s.pinned ?? []); setWidths(s.widths ?? {}); setSort(s.sort ?? null); setFilters(s.filters ?? {});
    setQ(s.q ?? ""); setDense(Boolean(s.dense)); setWrap(Boolean(s.wrap)); setActiveView(v.id); setPanel(null);
  };
  const saveView = async (name: string, id?: string) => {
    if (!viewScope) return;
    try {
      const { view } = await api<{ view: { id: string; name: string; state: ViewState } }>("/api/views", { body: { id, scope: viewScope, name, state: snapshot() } });
      setViews((vs) => [...vs.filter((x) => x.id !== view.id), view]); setActiveView(view.id); setNaming(null);
      toast.success(`View “${view.name}” saved`);
    } catch (e) { toast.error("Could not save the view", errorText(e)); }
  };
  const removeView = async (id: string) => {
    try { await api(`/api/views/${id}`, { method: "DELETE" }); setViews((vs) => vs.filter((x) => x.id !== id)); if (activeView === id) setActiveView(null); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  const reset = () => { setHidden(new Set()); setPinned([]); setWidths({}); setSort(null); setFilters({}); setQ(""); setActiveView(null); setPanel(null); };

  const pad = dense ? "px-3 py-1.5" : "px-4 py-2.5";
  const openRow = open !== null ? dataset.rows[open] : null;
  const openPos = open !== null ? rows.findIndex((x) => x.i === open) : -1;
  const totalW = 40 + columns.reduce((s, c) => s + widthOf(c), 0);
  const current = views.find((v) => v.id === activeView);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search all columns" className="w-full sm:w-64" />
        <span className="text-sm text-muted tabular-nums">{rows.length === dataset.rows.length ? `${rows.length.toLocaleString("en-IN")} rows` : `${rows.length.toLocaleString("en-IN")} of ${dataset.rows.length.toLocaleString("en-IN")} rows`}</span>
        {selected.size > 0 && (
          <span className="flex items-center gap-2">
            <Badge tone="accent">{selected.size.toLocaleString("en-IN")} selected</Badge>
            <button className="text-xs text-muted hover:text-text" onClick={() => setSelected(new Set())}>Clear</button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {viewScope && (
            <Popover label="Saved views" panelClassName="w-72" trigger={(p) => <Button {...p} size="sm" variant="ghost" icon={<Bookmark className="size-4" />}>{current ? current.name : "Views"}</Button>}>
              {(close) => (
                <div className="p-2">
                  {views.length ? (
                    <ul className="mb-2 space-y-0.5">
                      {views.map((v) => (
                        <li key={v.id} className="flex items-center gap-1">
                          <button type="button" className={cn("min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2", v.id === activeView && "font-semibold text-accent")} onClick={() => { apply(v); close(); }}>{v.name}</button>
                          <IconButton size="sm" label={`Delete view ${v.name}`} onClick={() => void removeView(v.id)}><Trash2 className="size-3.5" /></IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="px-2 py-1.5 text-xs text-muted">Save the columns, widths, pins, filters and sort you set up, and come back to them on every run.</p>}
                  <div className="flex flex-col gap-1 border-t border-border pt-2">
                    {current && <Button size="sm" variant="ghost" className="justify-start" icon={<Save className="size-4" />} onClick={() => { void saveView(current.name, current.id); close(); }}>Update “{current.name}”</Button>}
                    <Button size="sm" variant="ghost" className="justify-start" icon={<Bookmark className="size-4" />} onClick={() => { setNaming(""); close(); }}>Save as new view…</Button>
                    <Button size="sm" variant="ghost" className="justify-start" onClick={() => { reset(); close(); }}>Reset to default</Button>
                  </div>
                </div>
              )}
            </Popover>
          )}
          <IconButton label={dense ? "Comfortable rows" : "Compact rows"} onClick={() => setDense(!dense)}>{dense ? <Rows2 className="size-4" /> : <Rows4 className="size-4" />}</IconButton>
          <IconButton label={wrap ? "Truncate long text" : "Wrap long text"} onClick={() => setWrap(!wrap)} className={wrap ? "text-accent" : undefined}><WrapText className="size-4" /></IconButton>
          <Popover
            label="Columns"
            panelClassName="w-72"
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
                      <span className="flex items-center gap-1.5 text-[11px] text-muted">
                        {TYPE_ICON[types[c] ?? "text"]}
                        {fill?.[c] !== undefined && <span className={cn("tabular-nums", fill[c]! < 50 && "text-warning")}>{fill[c]}%</span>}
                      </span>
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

      {(activeFilters.length > 0 || sort) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
          {activeFilters.map(([c, f]) => (
            <span key={c} className="inline-flex h-7 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft/50 pr-1 pl-2.5 text-xs">
              <button type="button" onClick={() => setPanel(c)} className="hover:underline">{filterText(c, f)}</button>
              <button type="button" aria-label={`Remove filter on ${c}`} onClick={() => setFilters((x) => { const n = { ...x }; delete n[c]; return n; })} className="inline-flex size-5 items-center justify-center rounded-full hover:bg-surface"><X className="size-3" /></button>
            </span>
          ))}
          {sort && <span className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-xs text-muted">Sorted by {sort.col} {sort.dir === 1 ? "↑" : "↓"}<button type="button" aria-label="Clear sort" onClick={() => setSort(null)} className="ml-0.5"><X className="size-3" /></button></span>}
          {activeFilters.length > 1 && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setFilters({})}>Clear all</button>}
        </div>
      )}

      {panel && profile && (
        <ColumnPanel col={panel} profile={profile} filter={filters[panel]} numeric={numeric(panel)} pinned={pinned.includes(panel)}
          onFilter={(f) => setFilters((x) => { const n = { ...x }; if (f && filterActive(f)) n[panel] = f; else delete n[panel]; return n; })}
          onSort={(dir) => setSort({ col: panel, dir })} onPin={() => setPinned((p) => (p.includes(panel) ? p.filter((x) => x !== panel) : [...p, panel]))}
          onHide={() => { setHidden((h) => new Set(h).add(panel)); setPanel(null); }} onClose={() => setPanel(null)} />
      )}

      <div ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="scroll-thin hidden max-h-[70vh] overflow-auto border-t border-border md:block">
        <table className="text-sm" style={{ tableLayout: "fixed", width: Math.max(totalW, 0), minWidth: "100%" }}>
          <colgroup><col style={{ width: 40 }} />{columns.map((c) => <col key={c} style={{ width: widthOf(c) }} />)}</colgroup>
          <thead className="sticky top-0 z-20 bg-surface-2 text-left shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="sticky left-0 z-10 bg-surface-2 px-3">
                <Checkbox hideLabel label="Select all rows" checked={allFilteredSelected} indeterminate={selected.size > 0} onChange={(on) => setSelected(on ? new Set(rows.map((x) => x.i)) : new Set())} />
              </th>
              {columns.map((c) => {
                const isPinned = pinned.includes(c);
                const lastPinned = isPinned && pinned.filter((p) => columns.includes(p)).at(-1) === c;
                return (
                  <th key={c} scope="col" aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                    className={cn(pad, "group relative font-medium whitespace-nowrap", isPinned && "sticky z-10 bg-surface-2", lastPinned && "shadow-[1px_0_0_var(--border)]", panel === c && "text-accent")}
                    style={isPinned ? { left: leftOf(c) } : undefined}>
                    <div className={cn("flex items-center gap-1", numeric(c) && "justify-end")}>
                      <span className="text-muted" title={TYPE_LABEL[types[c] ?? "text"]}>{TYPE_ICON[types[c] ?? "text"]}</span>
                      <button onClick={() => toggleSort(c)} className="min-w-0 truncate hover:text-accent" title={`Sort by ${c}`}>{c}</button>
                      {sort?.col === c && (sort.dir === 1 ? <ArrowUp className="size-3.5 shrink-0" /> : <ArrowDown className="size-3.5 shrink-0" />)}
                      {isPinned && <Pin className="size-3 shrink-0 text-muted" aria-label="Pinned" />}
                      {fill?.[c] !== undefined && fill[c]! < 100 && <span className={cn("shrink-0 text-[10px] font-normal tabular-nums", fill[c]! < 50 ? "text-warning" : "text-muted")} title={`${fill[c]}% of rows have a value`}>{fill[c]}%</span>}
                      <button type="button" onClick={() => setPanel(panel === c ? null : c)} aria-label={`Stats and filter for ${c}`} title="Stats, filter, pin"
                        className={cn("ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-text", filterActive(filters[c]) ? "text-accent" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}>
                        <BarChart3 className="size-3.5" />
                      </button>
                    </div>
                    <span role="separator" aria-orientation="vertical" aria-label={`Resize ${c}`} onPointerDown={(e) => startResize(c, e)} onDoubleClick={() => setWidths((w) => { const n = { ...w }; delete n[c]; return n; })}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/40" />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {virtual && start > 0 && <tr aria-hidden style={{ height: start * rowH }}><td colSpan={columns.length + 1} /></tr>}
            {shown.map(({ r, i }) => (
              <tr key={i} className={cn("group/row cursor-pointer hover:bg-surface-2/60", selected.has(i) && "bg-accent-soft/30")} style={virtual ? { height: rowH } : undefined} onClick={() => setOpen(i)}>
                <td className="sticky left-0 bg-surface px-3 group-hover/row:bg-surface-2" onClick={(e) => e.stopPropagation()}>
                  <Checkbox hideLabel label={`Select row ${i + 1}`} checked={selected.has(i)} onChange={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(i); else n.delete(i); return n; })} />
                </td>
                {columns.map((c) => {
                  const isPinned = pinned.includes(c);
                  return (
                    <td key={c} className={cn(pad, "overflow-hidden", wrap ? "align-top" : "whitespace-nowrap", numeric(c) && "text-right", isPinned && "sticky bg-surface group-hover/row:bg-surface-2")} style={isPinned ? { left: leftOf(c) } : undefined}>
                      <CellView v={r[c] ?? null} wrap={wrap} type={types[c]} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {virtual && end < rows.length && <tr aria-hidden style={{ height: (rows.length - end) * rowH }}><td colSpan={columns.length + 1} /></tr>}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-8 text-center text-sm text-muted">{narrowed ? "No rows match the filters." : "No rows."}</p>}
        {!virtual && rows.length > wrapCount && <div className="border-t border-border p-2 text-center"><Button size="sm" variant="ghost" onClick={() => setWrapCount((n) => n + 200)}>Show {Math.min(200, rows.length - wrapCount)} more ({(rows.length - wrapCount).toLocaleString("en-IN")} left)</Button></div>}
      </div>

      <ul className="divide-y divide-border border-t border-border md:hidden">
        {rows.slice(0, mobileCount).map(({ r, i }) => (
          <li key={i} className="space-y-1.5 px-4 py-3" onClick={() => setOpen(i)}>
            {columns.slice(0, 6).map((c) => (
              <div key={c} className="grid grid-cols-[96px_1fr] gap-2 text-sm">
                <span className="truncate text-muted">{c}</span>
                <span className="min-w-0"><CellView v={r[c] ?? null} wrap type={types[c]} /></span>
              </div>
            ))}
            {columns.length > 6 && <p className="text-xs text-accent">+{columns.length - 6} more fields</p>}
          </li>
        ))}
        {rows.length > mobileCount && <li className="p-2"><Button size="sm" variant="ghost" className="w-full" onClick={() => setMobileCount((n) => n + 30)}>Show more ({(rows.length - mobileCount).toLocaleString("en-IN")} left)</Button></li>}
      </ul>

      <Dialog open={openRow !== null} onClose={() => setOpen(null)} title={`Row ${open !== null ? open + 1 : ""}`} wide
        description={openPos >= 0 ? `${openPos + 1} of ${rows.length.toLocaleString("en-IN")}${narrowed ? " filtered rows" : ""}` : undefined}
        footer={<>
          <Button variant="secondary" icon={<ClipboardCopy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(JSON.stringify(openRow, null, 2)).then(() => toast.success("Copied as JSON")); }}>Copy JSON</Button>
          <Button variant="secondary" disabled={openPos <= 0} onClick={() => setOpen(rows[openPos - 1]?.i ?? null)}>Previous</Button>
          <Button disabled={openPos < 0 || openPos >= rows.length - 1} onClick={() => setOpen(rows[openPos + 1]?.i ?? null)}>Next</Button>
        </>}
      >
        {openRow && <KeyValue items={dataset.columns.map((c) => ({ label: c, value: <CellView v={openRow[c] ?? null} wrap type={types[c]} /> }))} />}
      </Dialog>

      {naming !== null && (
        <Dialog open onClose={() => setNaming(null)} title="Save view" description="Columns, widths, pins, filters, search and sort."
          footer={<><Button variant="secondary" onClick={() => setNaming(null)}>Cancel</Button><Button disabled={!naming.trim()} onClick={() => void saveView(naming.trim())}>Save</Button></>}>
          <form onSubmit={(e) => { e.preventDefault(); if (naming.trim()) void saveView(naming.trim()); }}>
            <Input autoFocus aria-label="View name" value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="In stock under ₹5 000" maxLength={60} />
          </form>
        </Dialog>
      )}
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

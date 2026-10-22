"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Crosshair, Eye, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type { BrowserStep, Field, FetchMode, Transform } from "@/lib/schemas";
import type { Cell } from "@/lib/types";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { DataTable } from "./data-table";
import { Dialog } from "./dialog";
import { ElementPicker, type PickAction } from "./element-picker";
import { Badge, Button, Callout, Checkbox, Field as FormField, IconButton, Input, Segmented, Select, Switch, Textarea } from "./ui";
import { plural } from "@/lib/format";

export type ExtractValue =
  | { type: "auto" }
  | { type: "selectors"; itemSelector: string; fields: Field[] }
  | { type: "ai"; instruction: string; useFastModel: boolean };

export const newField = (name = "field", selector = "", attr = "text"): Field => ({ name, selector, attr, multiple: false, transforms: [], required: false });

const ATTRS = ["text", "href", "src", "html", "content", "title", "alt", "datetime", "value", "data-price"];

const TRANSFORMS: { op: Transform["op"]; label: string }[] = [
  { op: "trim", label: "Trim spaces" }, { op: "number", label: "To number" }, { op: "lower", label: "Lowercase" }, { op: "upper", label: "Uppercase" },
  { op: "stripHtml", label: "Strip HTML" }, { op: "absoluteUrl", label: "Absolute URL" }, { op: "regex", label: "Regex capture" },
  { op: "replace", label: "Find & replace" }, { op: "split", label: "Split, take part" }, { op: "prefix", label: "Add prefix" },
  { op: "suffix", label: "Add suffix" }, { op: "default", label: "Default if empty" },
];

function blankTransform(op: Transform["op"]): Transform {
  switch (op) {
    case "regex": return { op, pattern: "(\\d+)", group: 1 };
    case "replace": return { op, find: "", with: "", regex: false };
    case "split": return { op, separator: ",", index: 0 };
    case "prefix": case "suffix": case "default": return { op, value: "" };
    default: return { op } as Transform;
  }
}

/** Clean-up steps for one field, applied in order. */
export function TransformsEditor({ value, onChange }: { value: Transform[]; onChange: (v: Transform[]) => void }) {
  const set = (i: number, t: Transform) => onChange(value.map((x, k) => (k === i ? t : x)));
  return (
    <div className="space-y-2">
      {value.map((t, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-5 text-right text-xs text-muted">{i + 1}.</span>
          <Select aria-label="Transform" className="h-9 w-40" value={t.op} onChange={(e) => set(i, blankTransform(e.target.value as Transform["op"]))}>
            {TRANSFORMS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </Select>
          {t.op === "regex" && <>
            <Input aria-label="Pattern" className="h-9 w-48 font-mono text-xs" value={t.pattern} onChange={(e) => set(i, { ...t, pattern: e.target.value })} />
            <Input aria-label="Group" type="number" min={0} max={9} className="h-9 w-16" value={t.group} onChange={(e) => set(i, { ...t, group: Number(e.target.value) || 0 })} />
          </>}
          {t.op === "replace" && <>
            <Input aria-label="Find" className="h-9 w-36" placeholder="find" value={t.find} onChange={(e) => set(i, { ...t, find: e.target.value })} />
            <Input aria-label="Replace with" className="h-9 w-36" placeholder="replace with" value={t.with} onChange={(e) => set(i, { ...t, with: e.target.value })} />
            <Checkbox label="Regex" checked={t.regex} onChange={(v) => set(i, { ...t, regex: v })} />
          </>}
          {t.op === "split" && <>
            <Input aria-label="Separator" className="h-9 w-20" value={t.separator} onChange={(e) => set(i, { ...t, separator: e.target.value })} />
            <Input aria-label="Part index" type="number" min={-50} max={50} className="h-9 w-20" value={t.index} onChange={(e) => set(i, { ...t, index: Number(e.target.value) || 0 })} />
            <span className="text-xs text-muted">part (-1 = last)</span>
          </>}
          {(t.op === "prefix" || t.op === "suffix" || t.op === "default") && <Input aria-label="Value" className="h-9 w-48" value={t.value} onChange={(e) => set(i, { ...t, value: e.target.value })} />}
          <IconButton size="sm" label="Remove transform" onClick={() => onChange(value.filter((_, k) => k !== i))}><X className="size-4" /></IconButton>
        </div>
      ))}
      <Select aria-label="Add a transform" className="h-9 w-48" value="" onChange={(e) => { if (e.target.value) onChange([...value, blankTransform(e.target.value as Transform["op"])]); }}>
        <option value="">+ Add clean-up step</option>
        {TRANSFORMS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </Select>
    </div>
  );
}

type Probe = { count: number; samples?: string[] } | { error: string };

/** Live match count for one selector against the cached page (no new page load while typing). */
function useProbe(url: string, mode: FetchMode, selector: string, attr: string, enabled: boolean) {
  const [probe, setProbe] = useState<Probe | null>(null);
  useEffect(() => {
    if (!enabled || !url || !selector.trim()) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ count: number; samples?: string[] }>("/api/inspect/test", { body: { url, mode, selector, attr }, signal: ctrl.signal })
        .then(setProbe).catch((e) => { if ((e as Error).name !== "AbortError") setProbe({ error: errorText(e) }); });
    }, 500);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [url, mode, selector, attr, enabled]);
  return enabled && url && selector.trim() ? probe : null;
}

function ProbeBadge({ probe }: { probe: Probe | null }) {
  if (!probe) return null;
  if ("error" in probe) return <Badge tone="danger" className="max-w-56 truncate">{probe.error.length > 40 ? "invalid" : probe.error}</Badge>;
  return <Badge tone={probe.count ? "success" : "warning"}>{probe.count} match{probe.count === 1 ? "" : "es"}</Badge>;
}

function FieldRow({ field, onChange, onRemove, onMove, url, mode, live, withItem, first, last }: {
  field: Field; onChange: (f: Field) => void; onRemove: () => void; onMove: (d: number) => void; url: string; mode: FetchMode; live: boolean; withItem: boolean; first: boolean; last: boolean;
}) {
  const [more, setMore] = useState(field.transforms.length > 0 || field.required);
  // Inside an item, the count is for the whole page; still a useful "does it exist" signal.
  const probe = useProbe(url, mode, field.selector === ":scope" ? "" : field.selector, field.attr, live);
  const customAttr = !ATTRS.includes(field.attr);
  return (
    <li className="rounded-xl border border-border bg-surface p-3">
      <div className="grid gap-2 md:grid-cols-[150px_1fr_130px_auto] md:items-center">
        <Input aria-label="Column name" className="h-10" value={field.name} onChange={(e) => onChange({ ...field, name: e.target.value })} placeholder="name" />
        <div className="relative">
          <Input aria-label="CSS selector" className="h-10 pr-28 font-mono text-xs" value={field.selector} onChange={(e) => onChange({ ...field, selector: e.target.value })} placeholder={withItem ? "selector inside the item, e.g. .price" : "CSS selector, e.g. h1"} />
          <span className="absolute top-1/2 right-2 -translate-y-1/2"><ProbeBadge probe={probe} /></span>
        </div>
        <div className="flex gap-1">
          <Select aria-label="Read" className="h-10" value={customAttr ? "__custom" : field.attr} onChange={(e) => onChange({ ...field, attr: e.target.value === "__custom" ? "data-" : e.target.value })}>
            {ATTRS.map((a) => <option key={a} value={a}>{a === "text" ? "Text" : a === "html" ? "HTML" : `@${a}`}</option>)}
            <option value="__custom">Other attribute…</option>
          </Select>
        </div>
        <div className="flex items-center justify-end">
          <IconButton size="sm" label="Move up" disabled={first} onClick={() => onMove(-1)}><ArrowUp className="size-4" /></IconButton>
          <IconButton size="sm" label="Move down" disabled={last} onClick={() => onMove(1)}><ArrowDown className="size-4" /></IconButton>
          <IconButton size="sm" label="Remove field" onClick={onRemove}><Trash2 className="size-4" /></IconButton>
        </div>
      </div>
      {customAttr && <Input aria-label="Attribute name" className="mt-2 h-9 w-56 font-mono text-xs" value={field.attr} onChange={(e) => onChange({ ...field, attr: e.target.value })} placeholder="data-sku" />}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {!withItem && <Checkbox label="All matches (one row each)" checked={field.multiple} onChange={(v) => onChange({ ...field, multiple: v })} />}
        <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setMore(!more)}>
          {more ? "Hide options" : `Clean-up & options${field.transforms.length ? ` (${field.transforms.length})` : ""}`}
        </button>
        {probe && !("error" in probe) && probe.samples?.[0] && <span className="min-w-0 flex-1 truncate text-xs text-muted">e.g. “{probe.samples[0]}”</span>}
      </div>
      {more && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <Checkbox label="Required: drop rows where this is empty" checked={field.required} onChange={(v) => onChange({ ...field, required: v })} />
          <TransformsEditor value={field.transforms} onChange={(t) => onChange({ ...field, transforms: t })} />
        </div>
      )}
    </li>
  );
}

/** Field list with live checks, reorder and clean-up. Used for the main extraction and for detail pages. */
export function FieldsEditor({ fields, onChange, url, mode, live, withItem }: {
  fields: Field[]; onChange: (f: Field[]) => void; url: string; mode: FetchMode; live: boolean; withItem: boolean;
}) {
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {fields.map((f, i) => (
          <FieldRow key={i} field={f} url={url} mode={mode} live={live} withItem={withItem} first={i === 0} last={i === fields.length - 1}
            onChange={(n) => onChange(fields.map((x, k) => (k === i ? n : x)))}
            onRemove={() => onChange(fields.filter((_, k) => k !== i))}
            onMove={(d) => move(i, d)} />
        ))}
      </ul>
      <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange([...fields, newField(uniqueName(fields, "field"))])}>Add field</Button>
    </div>
  );
}

function uniqueName(fields: { name: string }[], base: string) {
  const names = new Set(fields.map((f) => f.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

type Suggestion = { itemSelector: string; fields: { name: string; selector: string; attr: string }[]; rows: Record<string, Cell>[]; count: number; note: string | null };

/**
 * How to get data out of a page: Auto (Scaper finds lists, tables, products), Selectors
 * (picked on the page, typed, or proposed by AI and tested), or AI extraction from a description.
 */
export function ExtractEditor({ value, onChange, url, mode, steps = [] }: {
  value: ExtractValue; onChange: (v: ExtractValue) => void; url: string; mode: FetchMode; steps?: BrowserStep[];
}) {
  const [picker, setPicker] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [describe, setDescribe] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [preview, setPreview] = useState<{ count: number; columns: string[]; rows: Record<string, Cell>[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [live, setLive] = useState(true);
  const validUrl = /^https?:\/\/\S+\.\S+/.test(url) || /^https?:\/\/localhost/.test(url);
  const sel = value.type === "selectors" ? value : null;
  const itemProbe = useProbe(url, mode, sel?.itemSelector ?? "", "text", live && Boolean(sel) && validUrl);
  const lastAi = useRef("");

  const setSelectors = (patch: Partial<{ itemSelector: string; fields: Field[] }>) => {
    const base = sel ?? { type: "selectors" as const, itemSelector: "", fields: [] };
    onChange({ ...base, ...patch });
  };
  const onPick = (a: PickAction) => {
    if (a.kind === "item") { setSelectors({ itemSelector: a.selector }); return; }
    const fields = sel?.fields.filter((f) => f.selector.trim()) ?? [];
    setSelectors({ fields: [...fields, { ...newField(uniqueName(fields, a.name), a.selector, a.attr), multiple: a.multiple }] });
  };
  const runAi = async () => {
    setAiBusy(true); setAiError(null); setSuggestion(null);
    lastAi.current = describe;
    try { setSuggestion(await api<Suggestion>("/api/ai/suggest", { body: { url, describe, mode } })); }
    catch (e) { setAiError(errorText(e)); }
    finally { setAiBusy(false); }
  };
  const runPreview = async () => {
    if (!sel) return;
    setPreviewing(true); setPreviewError(null);
    try { setPreview(await api("/api/inspect/test", { body: { url, mode, extract: { type: "selectors", itemSelector: sel.itemSelector, fields: sel.fields.filter((f) => f.selector.trim() && f.name.trim()) } } })); }
    catch (e) { setPreviewError(errorText(e)); setPreview(null); }
    finally { setPreviewing(false); }
  };

  return (
    <div className="space-y-4">
      <Segmented
        label="Extraction method"
        value={value.type}
        onChange={(t) => onChange(t === "auto" ? { type: "auto" } : t === "ai" ? { type: "ai", instruction: value.type === "ai" ? value.instruction : "", useFastModel: true } : { type: "selectors", itemSelector: sel?.itemSelector ?? "", fields: sel?.fields.length ? sel.fields : [newField("title")] })}
        options={[{ value: "auto", label: "Auto" }, { value: "selectors", label: "Selectors" }, { value: "ai", label: "AI" }]}
      />

      {value.type === "auto" && (
        <p className="text-sm text-muted">Scaper finds repeated items (product cards, results, posts), structured product data, tables, headings, links and images on its own. Good for a first look; switch to Selectors for exact columns.</p>
      )}

      {value.type === "ai" && (
        <div className="space-y-3">
          <FormField label="What should the AI extract?" hint="Plain language. The model only reads the page text; it never runs code or follows instructions found on the page.">
            {(p) => <Textarea {...p} value={value.instruction} onChange={(e) => onChange({ ...value, instruction: e.target.value })} placeholder="Every product with name, price, rating and link" />}
          </FormField>
          <Switch label="Use the fast model" description="Cheaper and quicker; switch off for complex pages." checked={value.useFastModel} onChange={(v) => onChange({ ...value, useFastModel: v })} />
        </div>
      )}

      {sel && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<Crosshair className="size-4" />} disabled={!validUrl} onClick={() => setPicker(true)}>Pick on page</Button>
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} disabled={!validUrl} onClick={() => { setAiOpen(true); setSuggestion(null); setAiError(null); }}>Build with AI</Button>
            <Button size="sm" variant="secondary" icon={<Eye className="size-4" />} disabled={!validUrl || !sel.fields.some((f) => f.selector.trim())} loading={previewing} onClick={runPreview}>Preview rows</Button>
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" className="accent-[var(--accent)]" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live match counts
            </label>
          </div>
          {!validUrl && <p className="text-xs text-muted">Enter the page URL first to use the picker, AI and live checks.</p>}

          <FormField label="Item selector (optional)" hint="One row per matching element (a product card, a table row). Leave empty to read single values from the whole page.">
            {(p) => (
              <div className="relative">
                <Input {...p} className="pr-28 font-mono text-xs" value={sel.itemSelector} onChange={(e) => setSelectors({ itemSelector: e.target.value })} placeholder="#results .card" />
                <span className="absolute top-1/2 right-2 -translate-y-1/2"><ProbeBadge probe={itemProbe} /></span>
              </div>
            )}
          </FormField>

          <div>
            <p className="mb-2 text-sm font-medium">Fields</p>
            <FieldsEditor fields={sel.fields} onChange={(f) => setSelectors({ fields: f })} url={url} mode={mode} live={live && validUrl} withItem={Boolean(sel.itemSelector.trim())} />
          </div>

          {previewError && <Callout tone="danger" title="Preview failed">{previewError}</Callout>}
          {preview && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="flex items-center justify-between bg-surface-2/60 px-4 py-2 text-sm">
                <span><span className="font-medium">{preview.count}</span> row{preview.count === 1 ? "" : "s"} on this page {preview.count > 10 ? "(first 10 shown)" : ""}</span>
                <IconButton size="sm" label="Close preview" onClick={() => setPreview(null)}><X className="size-4" /></IconButton>
              </div>
              {preview.rows.length ? <DataTable dataset={{ name: "Preview", columns: preview.columns, rows: preview.rows }} compact /> : <p className="p-4 text-sm text-muted">No rows. Check the item selector, or try Browser mode if the page builds its content with JavaScript.</p>}
            </div>
          )}
        </div>
      )}

      {validUrl && <ElementPicker url={url} open={picker} onClose={() => setPicker(false)} onPick={onPick} itemSelector={sel?.itemSelector ?? ""} steps={steps} />}

      <Dialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        wide
        title="Build selectors with AI"
        description="Describe the data. Your AI model proposes selectors, Scaper tests them on the page, and you choose whether to use them."
        footer={<>
          <Button variant="secondary" onClick={() => setAiOpen(false)}>Close</Button>
          {suggestion && suggestion.count > 0 && (
            <Button icon={<Wand2 className="size-4" />} onClick={() => {
              onChange({ type: "selectors", itemSelector: suggestion.itemSelector, fields: suggestion.fields.map((f) => newField(f.name, f.selector, f.attr)) });
              setAiOpen(false);
            }}>Use these selectors</Button>
          )}
        </>}
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="name, price, rating and link of each product" aria-label="Describe the data"
              onKeyDown={(e) => { if (e.key === "Enter" && describe.trim().length > 2) void runAi(); }} />
            <Button icon={<Sparkles className="size-4" />} loading={aiBusy} disabled={describe.trim().length < 3} onClick={runAi}>{suggestion ? "Try again" : "Suggest"}</Button>
          </div>
          {aiError && <Callout tone="danger" title="Could not build selectors">{aiError}</Callout>}
          {suggestion && (
            <div className="space-y-3">
              <Callout tone={suggestion.count ? "success" : "warning"} title={suggestion.count ? `${plural(suggestion.count, "row")} matched on the page` : "The proposal matched nothing"}>{suggestion.note}</Callout>
              <div className="rounded-lg bg-surface-2/60 p-3 font-mono text-xs">
                {suggestion.itemSelector && <p><span className="text-muted">item:</span> {suggestion.itemSelector}</p>}
                {suggestion.fields.map((f) => <p key={f.name}><span className="text-muted">{f.name}:</span> {f.selector}{f.attr !== "text" ? ` @${f.attr}` : ""}</p>)}
              </div>
              {suggestion.rows.length > 0 && <div className={cn("overflow-hidden rounded-xl border border-border")}><DataTable dataset={{ name: "AI suggestion", columns: Object.keys(suggestion.rows[0]!), rows: suggestion.rows }} compact /></div>}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Copy, Crosshair, FileUp, FlaskConical, Globe, Plus, Save, Trash2, X, Zap } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import { compilePatterns, matchesAny, parseUrlList } from "@/server/tasks/urls";
import { taskSchema, type FetchMode, type NotifyChannels, type TaskOptions } from "@/lib/schemas";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";
import { Dialog } from "./dialog";
import { ElementPicker } from "./element-picker";
import { ExtractEditor, FieldsEditor, newField, type ExtractValue } from "./extract-editor";
import { ChannelPicker, PaginationField, ScheduleField, type ScheduleValue } from "./form-bits";
import { ScrapeResultView, type RunView } from "./scrape-result";
import { StepsEditor } from "./steps-editor";
import { describeTask } from "./task-bits";
import { useToast } from "./toast";
import { Badge, Button, Callout, Card, Checkbox, Field, IconButton, Input, Kbd, Section, Segmented, Select, Switch, Tabs, TagInput, Textarea } from "./ui";

export type TaskDraft = {
  name: string; description: string; url: string; mode: FetchMode; extract: ExtractValue; options: TaskOptions; tags: string[];
  schedule: ScheduleValue; startUrlsText: string;
};

export function draftFromTask(t: Task): TaskDraft {
  return {
    name: t.name, description: t.description, url: t.url, mode: t.mode, tags: t.tags,
    extract: t.extract.type === "selectors" ? { type: "selectors", itemSelector: t.extract.itemSelector ?? "", fields: t.extract.fields } : t.extract,
    options: t.options,
    schedule: { kind: t.cron ? "cron" : t.schedule_minutes ? "interval" : "off", minutes: t.schedule_minutes ?? 360, cron: t.cron ?? "0 9 * * *" },
    startUrlsText: t.options.startUrls.join("\n"),
  };
}

type TabId = "start" | "pages" | "extract" | "steps" | "data" | "alerts" | "schedule";

/** Which tab holds the field a validation error points at. */
function tabFor(path: string): TabId {
  if (/^(extract|options\.(detail|aiColumns|aiFallback))/.test(path)) return "extract";
  if (/^options\.(startUrls|categories|sitemap|inputs|pagination|crawl|limits)/.test(path)) return "pages";
  if (/^options\.steps/.test(path)) return "steps";
  if (/^options\.(dedupeBy|quality|incremental|includeSourceUrl)/.test(path)) return "data";
  if (/^options\.(monitor|output)/.test(path)) return "alerts";
  if (/^(scheduleMinutes|cron|options\.retries)/.test(path)) return "schedule";
  return "start";
}

const fullUrlOf = (u: string) => (u && !/^https?:\/\//i.test(u.trim()) ? `https://${u.trim()}` : u.trim());

function buildPayload(d: TaskDraft) {
  return {
    name: d.name, description: d.description, url: fullUrlOf(d.url), mode: d.mode, extract: d.extract, tags: d.tags,
    options: {
      ...d.options,
      startUrls: d.startUrlsText.split(/\n+/).map((l) => l.trim()).filter(Boolean),
      detail: { ...d.options.detail, fields: d.options.detail.fields.filter((f) => f.selector.trim()) },
    },
    scheduleMinutes: d.schedule.kind === "interval" ? d.schedule.minutes : null,
    cron: d.schedule.kind === "cron" ? d.schedule.cron.trim() || null : null,
  };
}

/** CSV header and row count, for the inputs preview. */
function csvInfo(text: string) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const columns = lines[0]!.split(",").map((c) => c.trim().replace(/^"|"$/g, "")).filter(Boolean);
  return { columns, rows: lines.length - 1 };
}

export function TaskEditor({ id, initial }: { id?: string; initial: TaskDraft }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<TaskDraft>(initial);
  const [tab, setTab] = useQueryState<TabId>("tab", "start");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ run: RunView | null; error?: string } | null>(null);
  const [sampleDetailUrl, setSampleDetailUrl] = useState("");
  const [detailPicker, setDetailPicker] = useState(false);
  const [patternTest, setPatternTest] = useState("");
  const [saved, setSaved] = useState(() => JSON.stringify(buildPayload(initial)));
  const tagSource = useApi<{ tags: string[] }>("/api/tasks");

  const set = useCallback(<K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => setD((x) => ({ ...x, [k]: v })), []);
  const setOpt = useCallback(<K extends keyof TaskOptions>(k: K, v: TaskOptions[K]) => setD((x) => ({ ...x, options: { ...x.options, [k]: v } })), []);
  const o = d.options;
  const url = fullUrlOf(d.url);
  const payload = useMemo(() => buildPayload(d), [d]);
  const dirty = JSON.stringify(payload) !== saved;
  const fieldNames = d.extract.type === "selectors" ? d.extract.fields.map((f) => f.name).filter(Boolean) : d.extract.type === "ai" ? (d.extract.fields ?? []).map((f) => f.name) : [];
  const startUrls = useMemo(() => parseUrlList([d.startUrlsText]), [d.startUrlsText]);
  const csv = useMemo(() => csvInfo(o.inputs), [o.inputs]);
  const err = (path: string) => errors[path];
  const errorTabs = useMemo(() => {
    const m = new Map<TabId, number>();
    for (const p of Object.keys(errors)) m.set(tabFor(p), (m.get(tabFor(p)) ?? 0) + 1);
    return m;
  }, [errors]);
  const channelNames = (Object.entries(o.monitor.channels) as [keyof NotifyChannels, boolean][]).filter(([, v]) => v).map(([k]) => (k === "desktop" ? "inbox" : k));
  const summary = describeTask({
    url, mode: d.mode, extract: payload.extract as Parameters<typeof describeTask>[0]["extract"], options: payload.options as TaskOptions,
    startCount: startUrls.length, scheduleMinutes: payload.scheduleMinutes, cron: payload.cron, channels: channelNames,
  });

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const validate = () => {
    const parsed = taskSchema.safeParse(payload);
    if (parsed.success) { setErrors({}); return parsed.data; }
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "_", i.message]));
    setErrors(fields);
    const first = Object.keys(fields)[0];
    if (first) setTab(tabFor(first));
    return null;
  };

  const save = async () => {
    const body = validate();
    if (!body) { toast.error("Please fix the highlighted fields"); return; }
    setSaving(true);
    try {
      const { task } = await api<{ task: Task }>(id ? `/api/tasks/${id}` : "/api/tasks", { method: id ? "PUT" : "POST", body });
      setSaved(JSON.stringify(payload));
      toast.success(id ? "Task saved" : "Task created", task.next_run_at ? "The schedule is on." : undefined);
      router.push(`/tasks/${task.id}`);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setSaving(false); }
  };

  const testRun = async () => {
    const body = validate();
    if (!body) { toast.error("Please fix the highlighted fields first"); return; }
    setTesting(true); setTest(null);
    try {
      // A small, side-effect-free run: few pages, no files, no webhook, no alerts, nothing remembered.
      const options: TaskOptions = {
        ...body.options,
        limits: { maxPages: Math.min(body.options.limits.maxPages, 5), maxRows: Math.min(body.options.limits.maxRows, 500) },
        sitemap: { ...body.options.sitemap, limit: Math.min(body.options.sitemap.limit, 5) },
        pagination: body.options.pagination.type === "next" || body.options.pagination.type === "click" ? { ...body.options.pagination, maxPages: Math.min(body.options.pagination.maxPages, 3) } : body.options.pagination,
        output: { files: [], webhook: false }, incremental: false,
        monitor: { ...body.options.monitor, enabled: false }, quality: { ...body.options.quality, alert: false },
      };
      const res = await api<{ run: RunView | null; job: { error: string | null; status: string } }>("/api/scrape", { body: { url: body.url, mode: body.mode, extract: body.extract, options } });
      setTest({ run: res.run, error: res.run ? undefined : res.job.error ?? `The test is still ${res.job.status}. Check the Runs page.` });
    } catch (e) {
      setTest({ run: null, error: errorText(e) });
    } finally { setTesting(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const readCsvFile = async (file: File) => {
    if (file.size > 200_000) { toast.error("File too large", "Inputs are limited to 200 KB. Split the file into several tasks."); return; }
    setOpt("inputs", await file.text());
  };

  const tabs: { value: TabId; label: string; count?: number | null }[] = [
    { value: "start", label: "Start" },
    { value: "pages", label: "Pages" },
    { value: "extract", label: "Extract" },
    { value: "steps", label: "Page actions", count: o.steps.length || null },
    { value: "data", label: "Data quality" },
    { value: "alerts", label: "Alerts & output" },
    { value: "schedule", label: "Schedule" },
  ];

  const patternResult = patternTest.trim() ? {
    include: matchesAny(patternTest.trim(), compilePatterns(o.crawl.include), true),
    exclude: matchesAny(patternTest.trim(), compilePatterns(o.crawl.exclude), false),
  } : null;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="min-w-0">
        <Tabs value={tab} onChange={setTab} className="px-3" tabs={tabs.map((t) => ({ ...t, count: errorTabs.get(t.value) ? errorTabs.get(t.value) : t.count, label: errorTabs.get(t.value) ? `${t.label} ⚠` : t.label }))} />
        <div className="space-y-8 p-5">
          {Object.keys(errors).length > 0 && (
            <Callout tone="danger" icon={<AlertTriangle className="size-4 text-danger" />} title="Some fields need a fix">
              <ul className="mt-1 space-y-0.5">
                {Object.entries(errors).slice(0, 8).map(([p, m]) => (
                  <li key={p}><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setTab(tabFor(p))}><span className="font-mono text-xs">{p}</span>: {m}</button></li>
                ))}
              </ul>
            </Callout>
          )}

          {tab === "start" && (
            <>
              <Section title="The task" description="A name you will recognise in alerts and exports.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Name" error={err("name")}>{(p) => <Input {...p} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Laptops on example.com" autoFocus={!id} />}</Field>
                  <Field label="Tags" hint="Group and filter tasks.">{(p) => <TagInput id={p.id} value={d.tags} onChange={(v) => set("tags", v)} suggestions={tagSource.data?.tags ?? []} />}</Field>
                </div>
                <Field label="Start URL" error={err("url")} hint={o.inputs.trim() ? "You can use {{column}} from your CSV inputs here." : "The first page to open. Add more on the Pages tab."}>
                  {(p) => <Input {...p} inputMode="url" value={d.url} onChange={(e) => set("url", e.target.value)} placeholder="https://www.example.com/category/laptops" />}
                </Field>
                <Field label="Notes" hint="Optional. What this collects and why.">{(p) => <Textarea {...p} rows={2} value={d.description} onChange={(e) => set("description", e.target.value)} />}</Field>
              </Section>
              <Section title="How to load pages">
                <Segmented label="Fetch mode" value={d.mode} onChange={(v) => set("mode", v)} options={[
                  { value: "browser", label: "Browser", icon: <Globe className="size-4" /> },
                  { value: "fast", label: "Fast", icon: <Zap className="size-4" /> },
                ]} />
                <p className="text-xs text-muted">{d.mode === "browser" ? "A real Chromium runs the page's JavaScript. Needed for page actions, Next buttons, Load more and infinite scroll." : "Plain HTTP without JavaScript: 5–20× faster and lighter. Works for most server-rendered sites, feeds and APIs."}</p>
              </Section>
            </>
          )}

          {tab === "pages" && (
            <>
              <Section title="Categories" description="Each category is read with the next-page rules below, and every row gets a category column. A category scrape fills this in for you.">
                {o.categories.map((c, i) => (
                  <div key={i} className="flex gap-2">
                    <Input aria-label="Category name" className="w-44" value={c.name} onChange={(e) => setOpt("categories", o.categories.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="Laptops" />
                    <Input aria-label="Category URL" className="min-w-0 flex-1 font-mono text-xs" value={c.url} onChange={(e) => setOpt("categories", o.categories.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)))} placeholder="https://www.example.com/c/laptops" />
                    <IconButton label={`Remove ${c.name || "category"}`} onClick={() => setOpt("categories", o.categories.filter((_, k) => k !== i))}><Trash2 className="size-4" /></IconButton>
                  </div>
                ))}
                {err("options.categories") && <p className="text-xs text-danger">{err("options.categories")}</p>}
                <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={o.categories.length >= 500} onClick={() => setOpt("categories", [...o.categories, { name: "", url: "" }])}>Add category</Button>
              </Section>

              <Section title="More start URLs" description={<>One per line. Ranges and lists expand: <code className="font-mono">/page/{"{1..20}"}</code>, <code className="font-mono">/{"{tv,phones}"}</code>. Lines starting with # are skipped.</>}>
                <Field label="Start URLs" error={err("options.startUrls")}>
                  {(p) => <Textarea {...p} rows={4} className="font-mono text-xs" value={d.startUrlsText} onChange={(e) => set("startUrlsText", e.target.value)} placeholder={"https://www.example.com/category/laptops?page={2..10}\nhttps://www.example.com/category/{tablets,phones}"} />}
                </Field>
                {startUrls.length > 0 && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer"><Badge tone="accent">{startUrls.length.toLocaleString("en-IN")} URLs</Badge> plus the start URL. Show the first 20</summary>
                    <ul className="mt-2 space-y-0.5 font-mono">{startUrls.slice(0, 20).map((u) => <li key={u} className="truncate">{u}</li>)}</ul>
                  </details>
                )}
              </Section>

              <Section title="Inputs from a CSV" description="Run the same scrape for every row. {{column}} in the start URL, more URLs, and page-action text is replaced by that row's value.">
                <Textarea aria-label="CSV inputs" rows={5} className="font-mono text-xs" value={o.inputs} onChange={(e) => setOpt("inputs", e.target.value)} placeholder={"query,city\nwireless earbuds,Chennai\nusb c cable,Mumbai"} />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2">
                    <FileUp className="size-4" />Load CSV file
                    <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readCsvFile(f); e.target.value = ""; }} />
                  </label>
                  {csv && <><Badge tone="accent">{csv.rows} row{csv.rows === 1 ? "" : "s"}</Badge>{csv.columns.map((c) => (
                    <button key={c} type="button" title="Copy placeholder" onClick={() => { void navigator.clipboard.writeText(`{{${c}}}`); toast.info("Copied", `{{${c}}}`); }} className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 font-mono text-xs hover:text-accent"><Copy className="size-3" />{`{{${c}}}`}</button>
                  ))}</>}
                  {csv && !/\{\{\w/.test(d.url + d.startUrlsText + JSON.stringify(o.steps)) && <span className="text-xs text-warning">No {"{{column}}"} is used yet, so every row opens the same page.</span>}
                </div>
              </Section>

              <Section title="Pages from a sitemap" description="Read sitemap.xml (or a sitemap index) and visit the URLs in it.">
                <div className="grid gap-3 md:grid-cols-[1fr_220px_120px]">
                  <Field label="Sitemap URL" error={err("options.sitemap.url")}>{(p) => <Input {...p} className="font-mono text-xs" value={o.sitemap.url} onChange={(e) => setOpt("sitemap", { ...o.sitemap, url: e.target.value })} placeholder="https://www.example.com/sitemap.xml" />}</Field>
                  <Field label="Only URLs matching">{(p) => <Input {...p} className="font-mono text-xs" value={o.sitemap.include} onChange={(e) => setOpt("sitemap", { ...o.sitemap, include: e.target.value })} placeholder="/product/*" />}</Field>
                  <Field label="Max URLs">{(p) => <Input {...p} type="number" min={1} max={5000} value={o.sitemap.limit} onChange={(e) => setOpt("sitemap", { ...o.sitemap, limit: Number(e.target.value) || 1 })} />}</Field>
                </div>
              </Section>

              <Section title="Next pages" description="For lists split over several pages.">
                <PaginationField value={o.pagination} onChange={(v) => setOpt("pagination", v)} mode={d.mode} />
                {err("options.pagination.selector") && <p className="text-xs text-danger">{err("options.pagination.selector")}</p>}
              </Section>

              <Section title="Follow links (crawl)" description="Visit links found on each page and scrape those too." actions={<Switch label="Crawl" checked={o.crawl.enabled} onChange={(v) => setOpt("crawl", { ...o.crawl, enabled: v })} />}>
                {o.crawl.enabled && (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="Only follow URLs matching" hint="One per line. * stays within one path part, ** spans parts, /regex/ for regular expressions.">{(p) => <Textarea {...p} rows={3} className="font-mono text-xs" value={o.crawl.include} onChange={(e) => setOpt("crawl", { ...o.crawl, include: e.target.value })} placeholder={"/blog/*\n/docs/**"} />}</Field>
                      <Field label="Never follow URLs matching">{(p) => <Textarea {...p} rows={3} className="font-mono text-xs" value={o.crawl.exclude} onChange={(e) => setOpt("crawl", { ...o.crawl, exclude: e.target.value })} placeholder={"/tag/*\n*logout*"} />}</Field>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[1fr_140px]">
                      <Field label="Links to look at">{(p) => <Input {...p} className="font-mono text-xs" value={o.crawl.linkSelector} onChange={(e) => setOpt("crawl", { ...o.crawl, linkSelector: e.target.value })} />}</Field>
                      <Field label="Depth">{(p) => <Select {...p} value={o.crawl.maxDepth} onChange={(e) => setOpt("crawl", { ...o.crawl, maxDepth: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} level{n > 1 ? "s" : ""}</option>)}</Select>}</Field>
                    </div>
                    <Switch label="Stay on the same site" checked={o.crawl.sameHost} onChange={(v) => setOpt("crawl", { ...o.crawl, sameHost: v })} />
                    <div className="rounded-lg border border-dashed border-border p-3">
                      <Field label="Test a URL against these patterns">{(p) => <Input {...p} className="font-mono text-xs" value={patternTest} onChange={(e) => setPatternTest(e.target.value)} placeholder="https://www.example.com/blog/my-post" />}</Field>
                      {patternResult && (
                        <p className={cn("mt-2 flex items-center gap-1.5 text-sm", patternResult.include && !patternResult.exclude ? "text-success" : "text-danger")}>
                          {patternResult.include && !patternResult.exclude ? <><CheckCircle2 className="size-4" />Would be followed</> : <><X className="size-4" />Skipped: {patternResult.exclude ? "matches an exclude pattern" : "matches no include pattern"}</>}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Limits" description="A safety net, so a mistake can't run forever. Scaper still waits between requests to each site.">
                <div className="grid max-w-md grid-cols-2 gap-3">
                  <Field label="Max pages" error={err("options.limits.maxPages")}>{(p) => <Input {...p} type="number" min={1} max={5000} value={o.limits.maxPages} onChange={(e) => setOpt("limits", { ...o.limits, maxPages: Number(e.target.value) || 1 })} />}</Field>
                  <Field label="Max rows" error={err("options.limits.maxRows")}>{(p) => <Input {...p} type="number" min={1} max={100000} value={o.limits.maxRows} onChange={(e) => setOpt("limits", { ...o.limits, maxRows: Number(e.target.value) || 1 })} />}</Field>
                </div>
              </Section>
            </>
          )}

          {tab === "extract" && (
            <>
              <Section title="What to extract" description="On every page the task visits.">
                {err("extract.fields") && <p className="text-sm text-danger">{err("extract.fields")}</p>}
                {err("extract.instruction") && <p className="text-sm text-danger">{err("extract.instruction")}</p>}
                <ExtractEditor value={d.extract} onChange={(v) => set("extract", v)} url={url.includes("{{") ? "" : url} mode={d.mode} steps={o.steps} />
                {d.extract.type === "selectors" && (
                  <Switch label="Let the AI read pages where the selectors find nothing" description="Uses your fast model with the same column names, only on pages that would otherwise give no rows." checked={o.aiFallback} onChange={(v) => setOpt("aiFallback", v)} />
                )}
              </Section>

              <Section title="AI columns" description="Columns your AI fills in from each row after scraping: a category, a short summary, a yes/no check, a translation.">
                {o.aiColumns.map((c, i) => (
                  <div key={i} className="space-y-2 rounded-xl border border-border p-3">
                    <div className="flex gap-2">
                      <Input aria-label="Column name" className="w-44" value={c.name} onChange={(e) => setOpt("aiColumns", o.aiColumns.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="segment" />
                      <Input aria-label="What the AI fills in" className="min-w-0 flex-1" value={c.prompt} onChange={(e) => setOpt("aiColumns", o.aiColumns.map((x, k) => (k === i ? { ...x, prompt: e.target.value } : x)))} placeholder="budget, mid-range or premium, judged from price and title" />
                      <IconButton label={`Remove ${c.name || "column"}`} onClick={() => setOpt("aiColumns", o.aiColumns.filter((_, k) => k !== i))}><Trash2 className="size-4" /></IconButton>
                    </div>
                    {err(`options.aiColumns.${i}.prompt`) && <p className="text-xs text-danger">{err(`options.aiColumns.${i}.prompt`)}</p>}
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="min-w-60 flex-1"><TagInput label="Reads columns" value={c.from} onChange={(v) => setOpt("aiColumns", o.aiColumns.map((x, k) => (k === i ? { ...x, from: v } : x)))} suggestions={fieldNames} placeholder="All columns" max={20} /></div>
                      <Switch label="Fast model" checked={c.useFastModel} onChange={(v) => setOpt("aiColumns", o.aiColumns.map((x, k) => (k === i ? { ...x, useFastModel: v } : x)))} />
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-end gap-4">
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={o.aiColumns.length >= 5} onClick={() => setOpt("aiColumns", [...o.aiColumns, { name: "", prompt: "", from: [], useFastModel: true }])}>Add AI column</Button>
                  {o.aiColumns.length > 0 && <Field label="Fill at most this many rows per run">{(p) => <Input {...p} type="number" min={1} max={5000} className="w-32" value={o.aiColumnsMaxRows} onChange={(e) => setOpt("aiColumnsMaxRows", Number(e.target.value) || 1)} />}</Field>}
                </div>
              </Section>

              <Section title="Detail pages" description="Open each row's link and read more fields from that page (list → detail)." actions={<Switch label="Open detail pages" checked={o.detail.enabled} onChange={(v) => setOpt("detail", { ...o.detail, enabled: v, fields: o.detail.fields.length ? o.detail.fields : [newField("description")] })} />}>
                {o.detail.enabled && (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="Link column" hint="The field that holds each item's URL." error={err("options.detail.linkField")}>
                        {(p) => fieldNames.length ? (
                          <Select {...p} value={o.detail.linkField} onChange={(e) => setOpt("detail", { ...o.detail, linkField: e.target.value })}>
                            {!fieldNames.includes(o.detail.linkField) && <option value={o.detail.linkField}>{o.detail.linkField}</option>}
                            {fieldNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          </Select>
                        ) : <Input {...p} value={o.detail.linkField} onChange={(e) => setOpt("detail", { ...o.detail, linkField: e.target.value })} />}
                      </Field>
                      <Field label="Sample detail page" hint="Optional. Lets you pick fields and see live match counts. Not saved.">
                        {(p) => <Input {...p} className="font-mono text-xs" value={sampleDetailUrl} onChange={(e) => setSampleDetailUrl(e.target.value)} placeholder="https://www.example.com/item/123" />}
                      </Field>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" icon={<Crosshair className="size-4" />} disabled={!/^https?:\/\/\S+/.test(sampleDetailUrl)} onClick={() => setDetailPicker(true)}>Pick on the sample page</Button>
                    </div>
                    <FieldsEditor fields={o.detail.fields} onChange={(f) => setOpt("detail", { ...o.detail, fields: f })} url={sampleDetailUrl} mode={d.mode} live={/^https?:\/\/\S+/.test(sampleDetailUrl)} withItem={false} />
                    {d.extract.type === "selectors" && !fieldNames.includes(o.detail.linkField) && <p className="text-xs text-warning">Add a field named “{o.detail.linkField}” that reads the link (attribute href) in the list above.</p>}
                    {/^https?:\/\/\S+/.test(sampleDetailUrl) && (
                      <ElementPicker url={sampleDetailUrl} open={detailPicker} onClose={() => setDetailPicker(false)} itemSelector="" steps={[]}
                        onPick={(a) => { if (a.kind === "field") setOpt("detail", { ...o.detail, fields: [...o.detail.fields.filter((f) => f.selector.trim()), { ...newField(a.name, a.selector, a.attr), multiple: a.multiple }] }); }} />
                    )}
                  </div>
                )}
              </Section>
            </>
          )}

          {tab === "steps" && (
            <Section title="Page actions" description="Done on every page before it is read: close a cookie banner, choose a city, type a search, sort by newest. Your own logins belong in Sites → cookies, not here.">
              {d.mode === "fast" && <Callout tone="warning" title="Page actions need Browser mode">Switch the fetch mode on the Start tab, or these steps are skipped.</Callout>}
              <StepsEditor steps={o.steps} onChange={(s) => setOpt("steps", s)} url={url.includes("{{") ? "" : url} />
            </Section>
          )}

          {tab === "data" && (
            <>
              <Section title="Duplicates" description="Rows with the same value in these columns are kept once.">
                <TagInput label="Deduplicate by" value={o.dedupeBy} onChange={(v) => setOpt("dedupeBy", v)} suggestions={fieldNames} placeholder={fieldNames[0] ? `e.g. ${fieldNames.includes("link") ? "link" : fieldNames[0]}` : "column name"} max={10} />
              </Section>
              <Section title="Quality checks" description="Catch a run that silently returns broken data after a site redesign.">
                <div className="grid max-w-lg grid-cols-2 gap-3">
                  <Field label="At least this many rows">{(p) => <Input {...p} type="number" min={0} value={o.quality.minRows} onChange={(e) => setOpt("quality", { ...o.quality, minRows: Number(e.target.value) || 0 })} />}</Field>
                  <Field label="Each column at least % full">{(p) => <Input {...p} type="number" min={0} max={100} value={o.quality.minFillPercent} onChange={(e) => setOpt("quality", { ...o.quality, minFillPercent: Number(e.target.value) || 0 })} />}</Field>
                </div>
                <Switch label="Alert me when a check fails" checked={o.quality.alert} onChange={(v) => setOpt("quality", { ...o.quality, alert: v })} description="Uses the channels chosen on Alerts & output." />
              </Section>
              <Section title="Extras">
                <Switch label="Add a source URL column" description="Each row gets the page it came from." checked={o.includeSourceUrl} onChange={(v) => setOpt("includeSourceUrl", v)} />
                <Switch label="Only new detail pages" description={o.detail.enabled ? "Skip items already opened by an earlier run. Saves time on big lists." : "Turn on detail pages (Extract tab) to use this."} checked={o.incremental} onChange={(v) => setOpt("incremental", v)} disabled={!o.detail.enabled} />
              </Section>
            </>
          )}

          {tab === "alerts" && (
            <>
              <Section title="Alert on new or removed rows" description="Each run is compared with the previous good run." actions={<Switch label="Compare runs" checked={o.monitor.enabled} onChange={(v) => setOpt("monitor", { ...o.monitor, enabled: v, keyFields: o.monitor.keyFields.length ? o.monitor.keyFields : fieldNames.includes("link") ? ["link"] : fieldNames.slice(0, 1) })} />}>
                {o.monitor.enabled && (
                  <div className="space-y-4">
                    <Field label="A row is the same when these match" hint="Usually the link or an ID. Empty = the whole row.">
                      {(p) => <TagInput id={p.id} value={o.monitor.keyFields} onChange={(v) => setOpt("monitor", { ...o.monitor, keyFields: v })} suggestions={fieldNames} max={5} placeholder="link" />}
                    </Field>
                    <div className="flex flex-wrap gap-6">
                      <Switch label="New rows" checked={o.monitor.notifyNew} onChange={(v) => setOpt("monitor", { ...o.monitor, notifyNew: v })} />
                      <Switch label="Removed rows" checked={o.monitor.notifyRemoved} onChange={(v) => setOpt("monitor", { ...o.monitor, notifyRemoved: v })} />
                    </div>
                  </div>
                )}
              </Section>
              <Section title="Send alerts to" description="For new/removed rows and failed quality checks.">
                <ChannelPicker value={o.monitor.channels} onChange={(v) => setOpt("monitor", { ...o.monitor, channels: v })} />
              </Section>
              <Section title="Output" description="Every run is always kept on the Data page. These are extra copies.">
                <div className="flex flex-wrap gap-4">
                  {(["csv", "xlsx", "json", "ndjson"] as const).map((fmt) => (
                    <Checkbox key={fmt} label={fmt.toUpperCase()} checked={o.output.files.includes(fmt)} onChange={(v) => setOpt("output", { ...o.output, files: v ? [...o.output.files, fmt] : o.output.files.filter((x) => x !== fmt) })} />
                  ))}
                </div>
                <p className="text-xs text-muted">Files go to <code className="font-mono">data/exports/&lt;task name&gt;/</code>, one file per run.</p>
                <Switch label="Send rows to my webhook" description="POSTs JSON to the webhook URL from Settings → Alerts after each run." checked={o.output.webhook} onChange={(v) => setOpt("output", { ...o.output, webhook: v })} />
              </Section>
            </>
          )}

          {tab === "schedule" && (
            <>
              <Section title="When to run">
                <ScheduleField value={d.schedule} onChange={(v) => set("schedule", v)} minMinutes={15} />
                {(err("scheduleMinutes") || err("cron")) && <p className="text-sm text-danger">{err("scheduleMinutes") ?? err("cron")}</p>}
                {d.schedule.kind === "interval" && <p className="text-xs text-muted">The first run starts about a minute after you save.</p>}
              </Section>
              <Section title="When a run fails">
                <Field label="Retry" hint="Network errors and timeouts are retried with a growing pause. Blocked pages and robots.txt refusals are never retried.">
                  {(p) => <Select {...p} className="max-w-xs" value={o.retries} onChange={(e) => setOpt("retries", Number(e.target.value))}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? "Don't retry" : `Up to ${n} time${n > 1 ? "s" : ""}`}</option>)}</Select>}
                </Field>
              </Section>
            </>
          )}
        </div>
      </Card>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card className="p-4">
          <p className="text-sm font-semibold">What this task does</p>
          <ol className="mt-3 space-y-2 text-sm text-muted">
            {summary.map((s, i) => <li key={i} className="flex gap-2"><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-text tabular-nums">{i + 1}</span><span>{s}</span></li>)}
          </ol>
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            <Button onClick={save} loading={saving} icon={<Save className="size-4" />}>{id ? "Save changes" : "Create task"}</Button>
            <Button variant="secondary" onClick={testRun} loading={testing} icon={<FlaskConical className="size-4" />}>{testing ? "Testing…" : "Test run"}</Button>
            <p className="text-xs text-muted">Test runs read up to 5 pages, save nothing to the task and send no alerts. <Kbd>Ctrl</Kbd> <Kbd>S</Kbd> saves.</p>
            {dirty && <p className="text-xs font-medium text-warning">Unsaved changes</p>}
            {id && <Link prefetch={false} href={`/tasks/${id}`} className="text-center text-sm text-muted hover:text-text">Cancel</Link>}
          </div>
        </Card>
      </aside>

      <Dialog open={Boolean(test)} onClose={() => setTest(null)} xl title="Test run" description="Nothing is saved to the task. Adjust and test again, or save when it looks right.">
        {test?.error && <Callout tone="danger" icon={<AlertTriangle className="size-4 text-danger" />} title="The test did not finish">{test.error}</Callout>}
        {test?.run && (
          <ScrapeResultView run={test.run} onUseSelectors={(s) => { set("extract", { type: "selectors", ...s }); setTest(null); setTab("extract"); toast.info("Selectors loaded", "Rename the fields, then test again."); }} />
        )}
      </Dialog>
    </div>
  );
}

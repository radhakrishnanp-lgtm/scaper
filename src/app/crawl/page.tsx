"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { EyeOff, FolderTree, Info, Play, Plus, Save, Sparkles, Square, Trash2 } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ExtractEditor, newField, type ExtractValue } from "@/components/extract-editor";
import { PaginationField } from "@/components/form-bits";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { JobStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, Checkbox, Field, IconButton, Input, PageHeader, Progress, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import type { FetchMode, Pagination } from "@/lib/schemas";
import type { Cell } from "@/lib/types";
import { hostOf, plural } from "@/lib/format";

type Plan = {
  startUrl: string; title: string; goal: string; mode: FetchMode;
  categories: { name: string; url: string; picked: boolean; p?: number }[];
  sample: { url: string; itemSelector: string; fields: { name: string; selector: string; attr: string }[]; rows: Record<string, Cell>[]; count: number; note: string | null };
  pagination: Pagination; otherLinks: { name: string; url: string; p?: number }[]; notes: string[]; pickedBy?: "decisions" | "chat" | "none";
};
type Job = { id: string; status: string; error: string | null; progress: { done?: number; total?: number; rows?: number; label?: string }; result: { runId?: string } | null; private?: boolean };
type Log = { id: number; level: string; message: string };

const SCHEDULES = [{ v: "", l: "Run once now" }, { v: "60", l: "Every hour" }, { v: "360", l: "Every 6 hours" }, { v: "1440", l: "Every day" }, { v: "10080", l: "Every week" }];

/** Follows a job until it ends, then loads its result. */
function useJob(id: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [run, setRun] = useState<RunView | null>(null);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let after = 0;
    const tick = async () => {
      try {
        const r = await api<{ job: Job; logs: Log[] }>(`/api/jobs/${id}?after=${after}`);
        if (stop) return;
        setJob(r.job);
        if (r.logs.length) { after = r.logs[r.logs.length - 1]!.id; setLogs((l) => [...l, ...r.logs].slice(-60)); }
        if (["queued", "running"].includes(r.job.status)) { setTimeout(tick, 1500); return; }
        if (r.job.result?.runId) { const x = await api<{ run: RunView }>(`/api/runs/${r.job.result.runId}`); if (!stop) setRun(x.run); }
      } catch { if (!stop) setTimeout(tick, 4000); }
    };
    void tick();
    return () => { stop = true; };
  }, [id]);
  return { job, logs, run };
}

function CrawlPage() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [goal, setGoal] = useState(params.get("goal") ?? "");
  const [mode, setMode] = useState<FetchMode>("browser");
  const [maxCategories, setMaxCategories] = useState(8);
  const [pages, setPages] = useState(3);
  const [fast, setFast] = useState(false);
  const [priv, setPriv] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [plan, setPlan] = useState<Plan | null>(null);
  const [cats, setCats] = useState<Plan["categories"]>([]);
  const [extract, setExtract] = useState<ExtractValue>({ type: "auto" });
  const [pagination, setPagination] = useState<Pagination>({ type: "none" });
  const [maxRows, setMaxRows] = useState(5000);
  const [aiFallback, setAiFallback] = useState(true);
  const [dedupe, setDedupe] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, logs, run } = useJob(jobId);

  const fullUrl = url && !/^https?:\/\//i.test(url) ? `https://${url}` : url;
  const picked = cats.filter((c) => c.picked);

  const makePlan = async () => {
    setPlanning(true); setErrors({}); setPlan(null); setJobId(null);
    try {
      const { plan: p } = await api<{ plan: Plan }>("/api/crawl/plan", { body: { url: fullUrl, goal, mode, maxCategories, pagesPerCategory: pages, useFastModel: fast, private: priv || undefined } });
      setPlan(p);
      setCats(p.categories);
      setPagination(p.pagination);
      setExtract(p.sample.count
        ? { type: "selectors", itemSelector: p.sample.itemSelector, fields: p.sample.fields.map((f) => newField(f.name, f.selector, f.attr)) }
        : { type: "ai", instruction: goal, useFastModel: true, fields: [], scope: "list", input: "main" });
      setName(`${p.title.slice(0, 50) || hostOf(p.startUrl)}: ${goal.slice(0, 50)}`);
      const link = p.sample.fields.find((f) => /url|link|href/i.test(f.name));
      setDedupe(link?.name ?? "");
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not plan the scrape", errorText(e));
    } finally { setPlanning(false); }
  };

  const start = async (save: boolean) => {
    if (!plan) return;
    setStarting(true); setErrors({});
    const cleanExtract = extract.type === "selectors" ? { ...extract, fields: extract.fields.filter((f) => f.name.trim() && f.selector.trim()) } : extract;
    try {
      const res = await api<{ job: Job; taskId: string | null }>("/api/crawl/run", {
        body: {
          name, goal, startUrl: plan.startUrl, mode, categories: picked.map(({ name: n, url: u }) => ({ name: n, url: u })), extract: cleanExtract, pagination,
          maxPages: Math.min(5000, picked.length * Math.max(1, pages) + 5), maxRows, aiFallback, dedupeBy: dedupe ? [dedupe] : [], private: !save && priv ? true : undefined,
          save: save ? { scheduleMinutes: schedule ? Number(schedule) : null, cron: null } : undefined,
        },
      });
      if (save && res.taskId) {
        toast.success("Saved as a task", schedule ? "It runs now and then on its schedule." : "It is running now.", { label: "Open task", onClick: () => router.push(`/tasks/${res.taskId}`) });
      }
      setJobId(res.job.id);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not start", errorText(e));
    } finally { setStarting(false); }
  };
  const cancel = async () => {
    if (!jobId) return;
    try { await api(`/api/jobs/${jobId}/cancel`, { method: "POST" }); } catch (e) { toast.error("Could not stop", errorText(e)); }
  };
  const addCategory = (u: string, n?: string) => {
    if (!/^https?:\/\//i.test(u) || cats.some((c) => c.url === u)) return;
    setCats((c) => [...c, { name: n || new URL(u).pathname.split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ") || "Category", url: u, picked: true }]);
  };
  const running = job && ["queued", "running"].includes(job.status);

  return (
    <>
      <PageHeader title="Category scrape" description="Point Scaper at a site and say what you want. Your AI picks the category pages, Scaper works out the item layout, and every category is read page by page at the site's polite pace." />

      <Card className="mb-6">
        <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-muted" />1. Plan with your AI</span>} />
        <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void makePlan(); }}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Field label="Site or start page" error={errors.url}>{(f) => <Input {...f} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://books.toscrape.com" inputMode="url" />}</Field>
            <Field label="What do you want from it?" error={errors.goal} hint="Name categories to limit it, e.g. &quot;laptops and tablets: name, price, rating, link&quot;.">
              {(f) => <Textarea {...f} rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Every book in the Travel, Mystery and Poetry categories with title, price, stock and link" />}
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <p className="mb-1.5 text-sm font-medium">Fetch with</p>
              <Segmented label="Fetch mode" value={mode} onChange={setMode} options={[{ value: "browser", label: "Browser" }, { value: "fast", label: "Fast (HTML only)" }]} />
            </div>
            <Field label="Categories at most">{(f) => <Input {...f} type="number" min={1} max={50} className="w-28" value={maxCategories} onChange={(e) => setMaxCategories(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />}</Field>
            <Field label="Pages per category">{(f) => <Input {...f} type="number" min={1} max={100} className="w-28" value={pages} onChange={(e) => setPages(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />}</Field>
            <Switch label="Plan with the fast model" checked={fast} onChange={setFast} />
            <Switch label="Private" description="Nothing saved on this computer" checked={priv} onChange={setPriv} />
          </div>
          <div className="flex justify-end">
            <Button type="submit" icon={<Sparkles className="size-4" />} loading={planning} disabled={!url.trim() || goal.trim().length < 3}>{plan ? "Plan again" : "Make a plan"}</Button>
          </div>
          {planning && <p className="text-sm text-muted">Reading the start page, asking your AI for the categories and testing selectors on the first one. This takes 10 to 60 seconds.</p>}
        </form>
      </Card>

      {plan && (
        <>
          {plan.notes.length > 0 && (
            <Callout icon={<Info className="size-4 text-accent" />} title="What Scaper found">
              <ul className="list-disc space-y-0.5 pl-4">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </Callout>
          )}
          <div className="mt-6 grid gap-6">
            <Card>
              <CardHeader title={`2. Categories (${picked.length} of ${cats.length})`} description={`From ${plan.title || hostOf(plan.startUrl)}. ${plan.pickedBy === "decisions" ? "Picked by your decision model; the percentage is how likely each holds what you asked for. " : ""}Untick what you do not want, rename, or add more.`} />
              <div className="space-y-3 p-5">
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {cats.map((c, i) => (
                    <li key={c.url} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox label={`Include ${c.name}`} hideLabel checked={c.picked} onChange={(v) => setCats((x) => x.map((y, k) => (k === i ? { ...y, picked: v } : y)))} />
                      <div className="min-w-0 flex-1">
                        <Input aria-label="Category name" className="h-8" value={c.name} onChange={(e) => setCats((x) => x.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)))} />
                        <a href={c.url} target="_blank" rel="noreferrer" className="mt-0.5 block truncate font-mono text-xs text-muted hover:text-accent">{c.url}</a>
                      </div>
                      {c.p !== undefined && <Badge tone={c.p >= 0.7 ? "success" : "neutral"}>{Math.round(c.p * 100)}%</Badge>}
                      <IconButton label={`Remove ${c.name}`} onClick={() => setCats((x) => x.filter((_, k) => k !== i))}><Trash2 className="size-4" /></IconButton>
                    </li>
                  ))}
                </ul>
                {errors.categories && <p className="text-sm text-danger">{errors.categories}</p>}
                {plan.otherLinks.filter((l) => !cats.some((c) => c.url === l.url)).length > 0 && (
                  <Select aria-label="Add a link from the site's menu" value="" onChange={(e) => { const l = plan.otherLinks.find((x) => x.url === e.target.value); if (l) addCategory(l.url, l.name); }}>
                    <option value="">Add from the site&apos;s menu…</option>
                    {plan.otherLinks.filter((l) => !cats.some((c) => c.url === l.url)).map((l) => <option key={l.url} value={l.url}>{l.p !== undefined ? `${Math.round(l.p * 100)}% · ` : ""}{l.name} ({new URL(l.url).pathname})</option>)}
                  </Select>
                )}
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addCategory(addUrl.trim()); setAddUrl(""); }}>
                  <Input aria-label="Category URL" className="min-w-0 flex-1" value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="Or paste a category URL" />
                  <Button type="submit" variant="secondary" icon={<Plus className="size-4" />} disabled={!/^https?:\/\//i.test(addUrl.trim())}>Add</Button>
                </form>
              </div>
            </Card>

            <Card>
              <CardHeader title="3. What to collect" description={plan.sample.count ? `Tested on ${hostOf(plan.sample.url)}: ${plural(plan.sample.count, "item")} on the first page.` : "No selectors matched, so your AI reads each page. You can still build selectors here."} />
              <div className="space-y-4 p-5">
                {plan.sample.rows.length > 0 && (
                  <div className="overflow-hidden rounded-xl border border-border">
                    <DataTable dataset={{ name: "Sample", columns: Object.keys(plan.sample.rows[0]!), rows: plan.sample.rows.slice(0, 5) }} compact />
                  </div>
                )}
                <ExtractEditor value={extract} onChange={setExtract} url={plan.sample.url} mode={mode} />
                {extract.type === "selectors" && (
                  <Switch label="Let the AI read pages where the selectors find nothing" description="Some categories use a different layout. Costs tokens only on those pages." checked={aiFallback} onChange={setAiFallback} />
                )}
              </div>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader title="4. Pages, limits and run" />
            <div className="grid gap-5 p-5 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium">Next pages in each category</p>
                <PaginationField value={pagination} onChange={setPagination} mode={mode} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Task name">{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                <Field label="Stop after rows">{(f) => <Input {...f} type="number" min={1} max={100000} value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value) || 1)} />}</Field>
                <Field label="Skip duplicates by column" hint="Items listed in two categories are kept once.">{(f) => <Input {...f} value={dedupe} onChange={(e) => setDedupe(e.target.value)} placeholder="link" />}</Field>
                <Field label="When saved as a task">{(f) => (
                  <Select {...f} value={schedule} onChange={(e) => setSchedule(e.target.value)}>{SCHEDULES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</Select>
                )}</Field>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
              {priv && <Badge><EyeOff className="size-3" />Private run: results stay in memory for an hour</Badge>}
              <Button variant="secondary" icon={<Save className="size-4" />} loading={starting} disabled={!picked.length || Boolean(running)} onClick={() => void start(true)}>Save as task and run</Button>
              <Button icon={<Play className="size-4" />} loading={starting} disabled={!picked.length || Boolean(running)} onClick={() => void start(false)}>Run now</Button>
            </div>
          </Card>
        </>
      )}

      {jobId && (
        <Card className="mt-6">
          <CardHeader title={<span className="flex items-center gap-2"><FolderTree className="size-4 text-muted" />Run {job && <JobStatusBadge status={job.status} />}{job?.private && <Badge><EyeOff className="size-3" />private</Badge>}</span>}
            actions={running ? <Button size="sm" variant="secondary" icon={<Square className="size-4" />} onClick={cancel}>Stop</Button> : <Link prefetch={false} href={`/runs/${jobId}`} className="text-sm text-accent hover:underline">Open in Runs</Link>} />
          <div className="space-y-4 p-5">
            {job && (
              <div>
                <div className="mb-1 flex justify-between text-sm"><span>{job.progress.label ?? "Waiting for a free slot"}</span><span className="tabular-nums">{job.progress.rows ?? 0} rows{job.progress.total ? ` · page ${job.progress.done ?? 0} of up to ${job.progress.total}` : ""}</span></div>
                <Progress label="Progress" value={running ? (job.progress.total ? job.progress.done ?? 0 : null) : 1} max={running ? job.progress.total || 1 : 1} />
              </div>
            )}
            {job?.error && <Callout tone="danger" title="The run stopped">{job.error}</Callout>}
            {logs.length > 0 && (
              <details className="rounded-xl border border-border p-3" open={Boolean(running)}>
                <summary className="cursor-pointer text-sm font-medium">Log</summary>
                <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono text-xs">
                  {logs.map((l) => <li key={l.id} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-muted"}>{l.message}</li>)}
                </ul>
              </details>
            )}
          </div>
        </Card>
      )}
      {run && <div className="mt-6"><ScrapeResultView run={run} /></div>}
    </>
  );
}

export default function Page() {
  return <Suspense><CrawlPage /></Suspense>;
}

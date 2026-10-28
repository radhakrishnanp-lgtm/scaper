"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, ChevronDown, Clock, Download, FileSearch, Flame, Globe, ListChecks, Play, Save, ShieldCheck, Sparkles, Table2, Wand2, Zap } from "lucide-react";
import { openAssistant } from "@/components/assistant";
import { ExtractEditor, newField, type ExtractValue } from "@/components/extract-editor";
import { PaginationField } from "@/components/form-bits";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { RunStatusBadge } from "@/components/status";
import { StepsEditor } from "@/components/steps-editor";
import { useToast } from "@/components/toast";
import { Button, Card, CardHeader, Field, Input, PageHeader, Segmented, Switch } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import type { BrowserStep, FetchMode, Pagination } from "@/lib/schemas";
import { hostOf, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type RunsPage = { items: RunView[] };
/** Three ways to scrape, plus Smart, which picks the cheapest way that works. */
type Way = "smart" | "scraper" | "ai" | "firecrawl";
const WAY_HELP: Record<Way, string> = {
  smart: "Scaper picks the cheapest way that works: plain HTTP first, its own browser when the page needs JavaScript, and Firecrawl (credits) only when both fail. Auto finds the data.",
  scraper: "Scaper's own scraper, no AI and no credits: Auto finds the repeating items, or pick the fields yourself with selectors.",
  ai: "Scaper loads the page for free; your AI model reads it and returns a table from your description. Every call is in the AI log.",
  firecrawl: "Firecrawl loads the page with your key (1 credit), for pages Scaper cannot open itself; your AI model reads it.",
};

function ScrapePage() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const recent = useApi<RunsPage>("/api/runs?limit=8");

  const [url, setUrl] = useState(params.get("url") ?? "");
  const [goal, setGoal] = useState<"data" | "files">(params.get("goal") === "files" ? "files" : "data");
  const [way, setWayState] = useState<Way>("smart");
  const [mode, setMode] = useState<FetchMode>("auto");
  const [extract, setExtract] = useState<ExtractValue>({ type: "auto" });
  const [fileText, setFileText] = useState("");
  const aiExtract = (): ExtractValue => (extract.type === "ai" ? extract : { type: "ai", instruction: "", useFastModel: true });
  const setWay = (w: Way) => {
    setWayState(w);
    if (w === "smart") { setMode("auto"); if (extract.type === "ai") setExtract({ type: "auto" }); }
    if (w === "scraper") { setMode(mode === "fast" ? "fast" : "browser"); if (extract.type === "ai") setExtract({ type: "auto" }); }
    if (w === "ai") { setMode("auto"); setExtract(aiExtract()); }
    if (w === "firecrawl") { setMode("firecrawl"); setExtract(aiExtract()); }
  };
  const findFiles = () => router.push(`/bulk?url=${encodeURIComponent(fullUrl)}${fileText.trim() ? `&text=${encodeURIComponent(fileText.trim())}` : ""}`);
  const [steps, setSteps] = useState<BrowserStep[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ type: "none" });
  const [screenshot, setScreenshot] = useState(false);
  const [priv, setPriv] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [saving, setSaving] = useState(false);

  const fullUrl = url && !/^https?:\/\//i.test(url) ? `https://${url}` : url;
  const cleanExtract = () => (extract.type === "selectors" ? { ...extract, fields: extract.fields.filter((f) => f.selector.trim() && f.name.trim()) } : extract);
  const options = () => ({ steps, pagination });

  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const res = await api<{ run: RunView | null; job: { status: string; error: string | null; id: string } }>("/api/scrape", {
        body: { url: fullUrl, mode, extract: cleanExtract(), screenshot, private: priv || undefined, options: steps.length || pagination.type !== "none" ? options() : undefined },
      });
      if (res.run) {
        setRun(res.run);
        void recent.reload();
        if (res.run.status === "ok") toast.success("Scrape finished", `${res.run.row_count} row${res.run.row_count === 1 ? "" : "s"} from ${hostOf(fullUrl)}`);
      } else {
        toast.info(res.job.status === "running" || res.job.status === "queued" ? "Still running" : "The scrape did not finish", res.job.error ?? "Follow it on the Runs page.", { label: "Open run", onClick: () => router.push(`/runs/${res.job.id}`) });
      }
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not scrape", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAsTask = async () => {
    setSaving(true);
    try {
      const { task } = await api<{ task: { id: string } }>("/api/tasks", {
        body: { name: run?.result?.title?.slice(0, 80) || hostOf(fullUrl), url: fullUrl, mode, extract: cleanExtract(), options: options() },
      });
      toast.success("Saved as a task", "Add a schedule, more pages or alerts in the task editor.");
      router.push(`/tasks/${task.id}/edit`);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader
        title="Quick scrape"
        description="Pull data out of one page now. For many pages, schedules and alerts, save it as a task."
        actions={<div className="flex flex-wrap gap-2">
          <Link prefetch={false} href={`/decisions?tab=check${url.trim() ? `&url=${encodeURIComponent(url.trim())}` : ""}`}><Button variant="secondary" icon={<ShieldCheck className="size-4" />}>Is it OK to scrape?</Button></Link>
          <Link prefetch={false} href="/tasks"><Button variant="secondary" icon={<ListChecks className="size-4" />}>Tasks</Button></Link>
        </div>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); if (goal === "files") findFiles(); else void submit(); }} className="space-y-5 p-5">
              <Field label="Page URL" error={errors.url}>
                {(p) => <Input {...p} inputMode="url" placeholder="https://www.example.com/products" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus required />}
              </Field>

              <div>
                <p className="mb-1.5 text-sm font-medium">What do you want from it?</p>
                <Segmented label="Goal" value={goal} onChange={setGoal} options={[
                  { value: "data", label: "Data (a table)", icon: <Table2 className="size-4" /> },
                  { value: "files", label: "Download files", icon: <Download className="size-4" /> },
                ]} />
              </div>

              {goal === "files" ? (
                <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
                  <p className="text-sm">Scaper finds every file this site offers: PDFs, ebooks, images, video, audio, documents, archives or any file ending, including lists where each item has its own page with the real download link. You review the list, then download all or some.</p>
                  <Field label="What to download (optional)" hint="In your words, for your AI. Page text is never treated as instructions.">
                    {(p) => <Input {...p} value={fileText} onChange={(e) => setFileText(e.target.value)} placeholder="Every chapter PDF and the EPUB of each book" />}
                  </Field>
                  <p className="text-xs text-muted">Smart by default: free loading first, your AI only on pages where Scaper&apos;s rules find nothing, and Firecrawl only if you switch it on (one site-map call is about 1 credit).</p>
                </div>
              ) : (
                <>
                  <div>
                    <p className="mb-1.5 text-sm font-medium">How to scrape it</p>
                    <Segmented label="Way to scrape" value={way} onChange={setWay} options={[
                      { value: "smart", label: "Smart", icon: <Wand2 className="size-4" /> },
                      { value: "scraper", label: "Scraper only", icon: <Table2 className="size-4" /> },
                      { value: "ai", label: "Pure AI", icon: <Sparkles className="size-4" /> },
                      { value: "firecrawl", label: "Firecrawl + AI", icon: <Flame className="size-4" /> },
                    ]} />
                    <p className="mt-1.5 text-xs text-muted">{WAY_HELP[way]}{way === "firecrawl" && <> Add the key in <Link className="text-accent hover:underline" href="/integrations?tab=firecrawl">Integrations → Firecrawl</Link>.</>}</p>
                  </div>

                  {way === "scraper" && (
                    <div>
                      <p className="mb-1.5 text-sm font-medium">How to load it</p>
                      <Segmented label="Fetch mode" value={mode} onChange={setMode} options={[
                        { value: "browser", label: "Browser", icon: <Globe className="size-4" /> },
                        { value: "fast", label: "Fast", icon: <Zap className="size-4" /> },
                      ]} />
                      <p className="mt-1.5 text-xs text-muted">{mode === "browser" ? "Runs JavaScript like a real browser. Works on most modern sites." : "Plain HTTP, no JavaScript. Much faster and lighter."}</p>
                    </div>
                  )}

                  <div>
                    <p className="mb-1.5 text-sm font-medium">What to extract</p>
                    <ExtractEditor value={extract} onChange={(v) => { setExtract(v); if (v.type === "ai" && way !== "firecrawl" && way !== "ai") setWayState("ai"); if (v.type !== "ai" && (way === "ai" || way === "firecrawl")) setWayState(way === "firecrawl" ? "scraper" : "smart"); }} url={fullUrl} mode={mode} steps={steps} />
                  </div>
                </>
              )}

              <div className="rounded-xl border border-border">
                <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium" onClick={() => setMore(!more)} aria-expanded={more}>
                  <span>More options <span className="font-normal text-muted">· page actions, next pages, screenshot, private</span></span>
                  <ChevronDown className={more ? "size-4 rotate-180 transition-transform" : "size-4 transition-transform"} />
                </button>
                {more && goal === "data" && (
                  <div className="space-y-5 border-t border-border p-4">
                    <div>
                      <p className="mb-1 text-sm font-medium">Page actions <span className="font-normal text-muted">(Browser mode)</span></p>
                      <p className="mb-3 text-xs text-muted">Click a cookie banner, type a search, choose a city … before the page is read.</p>
                      <StepsEditor steps={steps} onChange={setSteps} url={fullUrl} />
                    </div>
                    <PaginationField value={pagination} onChange={setPagination} mode={mode} />
                    <Switch checked={screenshot} onChange={setScreenshot} label="Take a screenshot" description="Browser mode only. Loads images, so it is a little slower." disabled={mode === "fast" || mode === "firecrawl"} />
                    <Switch checked={priv} onChange={setPriv} label="Private" description="Keep the result in memory for an hour only: nothing saved in Data, the AI log or site statistics." />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {goal === "files" ? <Button type="submit" icon={<FileSearch className="size-4" />} disabled={!url.trim()}>Open the bulk downloader</Button> : <>
                <Button type="submit" loading={busy} icon={<Play className="size-4" />}>{busy ? "Scraping…" : "Scrape"}</Button>
                <Button type="button" variant="secondary" icon={<Save className="size-4" />} onClick={saveAsTask} loading={saving} disabled={!url}>Save as task</Button>
                {extract.type === "selectors" && extract.fields.length === 0 && <Button type="button" variant="ghost" onClick={() => setExtract({ ...extract, fields: [newField("title")] })}>Add a field</Button>}
                </>}
                <span className="flex-1" />
                <Button type="button" variant="ghost" icon={<Bot className="size-4 text-accent" />} disabled={!url.trim()}
                  onClick={() => openAssistant({ session: { key: `site:${hostOf(fullUrl)}`, name: hostOf(fullUrl), focus: { kind: "site", title: `The site ${hostOf(fullUrl)}; I may want its data or its files`, url: fullUrl } } })}>Let my AI decide</Button>
              </div>
            </form>
          </Card>

          {busy && !run && <Card className="p-5"><div className="skeleton h-40 rounded-lg" role="status" aria-label="Scraping" /></Card>}
          {run && (
            <ScrapeResultView
              run={run}
              actions={<Button size="sm" variant="secondary" icon={<Save className="size-4" />} onClick={saveAsTask} loading={saving}>Save as task</Button>}
              onUseSelectors={(s) => { setExtract({ type: "selectors", ...s }); window.scrollTo({ top: 0, behavior: "smooth" }); toast.info("Selectors loaded", "Rename or adjust the fields, then scrape again."); }}
            />
          )}
        </div>

        <Card className="h-fit">
          <CardHeader title="Recent runs" actions={<Link prefetch={false} href="/history" className="text-sm font-medium text-accent hover:underline">All data</Link>} />
          {recent.loading ? <div className="p-5"><div className="skeleton h-20 rounded-lg" /></div> : !recent.data?.items.length ? (
            <div className="flex flex-col items-center px-5 py-8 text-center text-sm text-muted"><Clock className="mb-2 size-5" />Your scrapes appear here.</div>
          ) : (
            <ul className="divide-y divide-border">
              {recent.data.items.map((r) => (
                <li key={r.id}>
                  <Link prefetch={false} href={`/history/${r.id}`} className="block px-4 py-3 hover:bg-surface-2/50">
                    <p className="truncate text-sm font-medium">{hostOf(r.url)}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted"><RunStatusBadge status={r.status} />{plural(r.row_count, "row")} · {timeAgo(r.created_at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense><ScrapePage /></Suspense>;
}

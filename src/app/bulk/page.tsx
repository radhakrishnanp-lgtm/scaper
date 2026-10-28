"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CloudDownload, Download, Flame, FolderOpen, Sparkles } from "lucide-react";
import type { Download as DownloadRow } from "@/server/repo/downloads";
import { FinderResults, type FinderInfo } from "@/components/file-finder";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Progress, Segmented, Switch, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { bytes, hostOf, plural, timeAgo } from "@/lib/format";
import { FILE_KINDS, kindsFromText, type FileKind } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

const KIND_LABEL: Record<FileKind, string> = { pdf: "PDF", ebook: "Ebooks", image: "Images", video: "Video", audio: "Audio", document: "Documents", archive: "Archives" };
const ALL = Object.keys(FILE_KINDS) as FileKind[];

/**
 * The bulk downloader: any website plus what you want in your own words. Scaper finds the matching files (its rules,
 * your AI where the rules find nothing, and Firecrawl's site map when you allow it) and downloads them as they are found,
 * several at a time.
 */
function BulkPage() {
  const params = useSearchParams();
  const toast = useToast();
  const finder = useApi<FinderInfo>("/api/files");
  const ready = finder.data?.ready ?? { ai: false, firecrawl: false };
  const [urls, setUrls] = useState(params.get("url") ?? "");
  const [want, setWant] = useState(params.get("text") ?? "");
  const [picked, setPicked] = useState<FileKind[] | null>(null);
  const [depth, setDepth] = useState<"0" | "1" | "2">("1");
  const [useMap, setUseMap] = useState<boolean | null>(null);
  const [useAi, setUseAi] = useState<boolean | null>(null);
  const [parallel, setParallel] = useState<string>("");
  const [maxFiles, setMaxFiles] = useState("500");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(params.get("job"));

  const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`));
  const guess = kindsFromText(want);
  const kinds = picked ?? guess.kinds;
  const map = useMap ?? ready.firecrawl;
  const ai = useAi ?? ready.ai;
  const toggle = (k: FileKind) => setPicked((kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]));

  const start = async () => {
    setBusy(true);
    try {
      if (parallel) await api("/api/settings", { method: "PUT", body: { data: { downloadConcurrency: Math.min(8, Math.max(1, Number(parallel) || 3)) } } });
      const r = await api<{ job: { id: string } }>("/api/files", { body: {
        urls: list, kinds, extensions: guess.extensions, instruction: want.trim(), picker: ai ? "auto" : "rules", mode: "auto", siteMap: map && ready.firecrawl,
        depth: Number(depth), maxPages: 200, maxFiles: Math.min(2000, Math.max(1, Number(maxFiles) || 500)), followNext: true, sameSite: true,
        download: true, folder: folder.trim() || (list[0] ? hostOf(list[0]) : "Bulk download"),
      } });
      setJobId(r.job.id);
      void finder.reload();
      toast.success("Started", "Files download as soon as they are found.");
    } catch (e) { toast.error("Could not start", errorText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader
        title="Bulk download"
        description="Give any website and say what you want. Scaper finds every matching file and downloads them, several at a time, as they are found."
        actions={<Link prefetch={false} href="/downloads"><Button variant="secondary" icon={<FolderOpen className="size-4" />}>All downloads</Button></Link>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form className="space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); void start(); }}>
              <Field label="Website" hint="A page that lists or links to the files. More than one: one per line.">
                {(p) => <Textarea {...p} rows={2} className="font-mono text-xs" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://example.com/library" required autoFocus />}
              </Field>
              <Field label="What do you want to download?" hint="In your own words. Your AI uses it on pages where Scaper's rules find nothing; page text is never treated as instructions.">
                {(p) => <Textarea {...p} rows={2} value={want} onChange={(e) => setWant(e.target.value)} placeholder="Every lecture PDF and the slides, not the sample chapters" />}
              </Field>
              <div>
                <p className="mb-2 text-sm font-medium">Files {picked ? "" : <span className="font-normal text-muted">(read from what you wrote; click to change)</span>}</p>
                <div className="flex flex-wrap gap-1.5">
                  {ALL.map((k) => (
                    <button key={k} type="button" aria-pressed={kinds.includes(k)} onClick={() => toggle(k)}
                      className={kinds.includes(k) ? "rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-medium text-accent" : "rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-text"}>{KIND_LABEL[k]}</button>
                  ))}
                  {guess.extensions.map((e) => <Badge key={e}>.{e}</Badge>)}
                  <button type="button" className="px-2 text-xs text-accent hover:underline" onClick={() => setPicked(kinds.length === ALL.length ? ["pdf"] : ALL)}>{kinds.length === ALL.length ? "Fewer" : "Any file"}</button>
                </div>
              </div>
              <Field label="Where are the download links?">{() => (
                <Segmented label="Where are the download links" value={depth} onChange={setDepth} options={[
                  { value: "0", label: "On this page" }, { value: "1", label: "On each item's page" }, { value: "2", label: "One more page after that" },
                ]} />
              )}</Field>
              <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                <Switch checked={map && ready.firecrawl} disabled={!ready.firecrawl} onChange={setUseMap} label="Fast: list the whole site with Firecrawl (about 1 credit)"
                  description={ready.firecrawl ? "One call returns the site's links, so files come without opening every page." : <>Add a Firecrawl key in <Link className="text-accent hover:underline" href="/integrations?tab=firecrawl">Integrations</Link> to use this.</>} />
                <Switch checked={ai && ready.ai} disabled={!ready.ai} onChange={setUseAi} label="Let my AI read pages where the rules find nothing"
                  description={ready.ai ? "Uses your fast model only where needed. Every call is in the AI log." : "Connect a model in Settings → AI to use this."} />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Downloads at once" hint="1 to 8. Each site's polite delay still applies.">{(p) => <Input {...p} type="number" min={1} max={8} value={parallel} onChange={(e) => setParallel(e.target.value)} placeholder="Same as now" />}</Field>
                <Field label="Most files">{(p) => <Input {...p} type="number" min={1} max={2000} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />}</Field>
                <Field label="Folder">{(p) => <Input {...p} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={list[0] ? hostOf(list[0]) : "Bulk download"} />}</Field>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button type="submit" loading={busy} disabled={!list.length || (!kinds.length && !guess.extensions.length)} icon={<CloudDownload className="size-4" />}>Find and download</Button>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  {map && ready.firecrawl && <><Flame className="size-3.5" />Firecrawl map ·</>}{ai && ready.ai && <><Sparkles className="size-3.5" />your AI ·</>} robots.txt and site delays apply
                </span>
              </div>
            </form>
          </Card>
          {jobId && <FinderResults key={jobId} jobId={jobId} onClose={() => setJobId(null)} onQueued={() => undefined} />}
          {jobId && <LiveDownloads jobId={jobId} />}
        </div>
        <Card className="h-fit">
          <CardHeader title="Recent bulk downloads" />
          {!finder.data?.jobs.length ? <p className="px-5 pb-5 text-sm text-muted">Your searches appear here.</p> : (
            <ul className="divide-y divide-border">
              {finder.data.jobs.slice(0, 10).map((j) => (
                <li key={j.id}>
                  <button type="button" className="block w-full px-4 py-3 text-left hover:bg-surface-2/50" onClick={() => setJobId(j.id)}>
                    <p className="truncate text-sm font-medium">{j.title.replace(/^Find files on /, "")}</p>
                    <p className="mt-0.5 text-xs text-muted">{j.status} · {plural(((j.result as { files?: unknown[] } | null)?.files?.length) ?? 0, "file")} · {timeAgo(j.created_at)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/** The files this search sent to Downloads, with live progress. */
function LiveDownloads({ jobId }: { jobId: string }) {
  const { data } = useApi<{ items: DownloadRow[] }>(`/api/downloads?ref=${jobId}&limit=500`, { pollMs: 1500 });
  const items = data?.items ?? [];
  if (!items.length) return null;
  const count = (s: string) => items.filter((d) => d.status === s).length;
  const done = count("done");
  const total = items.reduce((n, d) => n + d.bytes, 0);
  return (
    <section aria-label="Downloading" className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Download className="size-4 text-accent" />
        <h2 className="font-semibold">Downloading</h2>
        <span className="text-xs text-muted">{done} of {items.length} saved · {count("running")} downloading · {count("queued")} waiting{count("failed") ? ` · ${count("failed")} failed` : ""} · {bytes(total)}</span>
        <span className="flex-1" />
        <Link prefetch={false} href="/downloads" className="text-sm text-accent hover:underline">Open Downloads</Link>
      </div>
      <Progress value={(done / items.length) * 100} label="Files saved" tone={count("failed") ? "warning" : "accent"} />
      <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto text-xs">
        {items.slice(0, 200).map((d) => (
          <li key={d.id} className="flex items-center gap-2">
            <Badge tone={d.status === "done" ? "success" : d.status === "failed" ? "danger" : d.status === "running" ? "accent" : "neutral"}>{d.status}</Badge>
            <span className="min-w-0 flex-1 truncate">{d.file_name}</span>
            <span className="tabular-nums text-muted">{bytes(d.bytes)}{d.total_bytes ? ` / ${bytes(d.total_bytes)}` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Page() {
  return <Suspense><BulkPage /></Suspense>;
}

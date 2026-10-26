"use client";

import { useEffect, useState } from "react";
import { Copy, Download, FileSearch, FileText, Loader2, X } from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import type { FinderResult } from "@/server/files/finder";
import { Dialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Checkbox, Field, Input, Progress, Segmented, Switch, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { bytes, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export type FinderInfo = { jobs: Job[]; ready: { ai: boolean; firecrawl: boolean } };

const KINDS = [
  { value: "pdf", label: "PDF" }, { value: "ebook", label: "Ebooks (EPUB, MOBI…)" }, { value: "image", label: "Images" }, { value: "video", label: "Video" },
  { value: "audio", label: "Audio" }, { value: "document", label: "Documents (Word, Excel…)" }, { value: "archive", label: "Archives (ZIP, RAR…)" },
] as const;

/** The form: where to start, which files, and who picks the links. */
export function FindFilesDialog({ initialUrl = "", ready, onClose, onStarted }: { initialUrl?: string; ready: FinderInfo["ready"]; onClose: () => void; onStarted: (jobId: string) => void }) {
  const toast = useToast();
  const [urls, setUrls] = useState(initialUrl);
  const [kinds, setKinds] = useState<string[]>(["pdf", "ebook"]);
  const [extensions, setExtensions] = useState("");
  const [instruction, setInstruction] = useState("");
  const [picker, setPicker] = useState<"rules" | "ai" | "firecrawl">("rules");
  const [mode, setMode] = useState<"fast" | "browser" | "firecrawl">("fast");
  const [depth, setDepth] = useState<"0" | "1" | "2">("1");
  const [maxPages, setMaxPages] = useState("40");
  const [followNext, setFollowNext] = useState(true);
  const [sameSite, setSameSite] = useState(true);
  const [download, setDownload] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const exts = extensions.split(/[\s,]+/).map((e) => e.replace(/^\./, "").trim().toLowerCase()).filter(Boolean);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ job: Job }>("/api/files", { body: {
        urls: list, kinds, extensions: exts, instruction, picker, mode, depth: Number(depth), maxPages: Number(maxPages) || 40, followNext, sameSite, download, folder,
      } });
      toast.success("Looking for files", "Results appear below as pages are read.");
      onStarted(r.job.id); onClose();
    } catch (e) { toast.error("Could not start", errorText(e)); } finally { setBusy(false); }
  };
  const toggle = (k: string) => setKinds((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]));
  return (
    <Dialog open onClose={onClose} wide title="Find files on a site"
      description="Scaper reads the page, keeps the file links and opens each item's own page when the real download link is there. robots.txt and the site's delays apply to every page."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!list.length || (!kinds.length && !exts.length)} icon={<FileSearch className="size-4" />} onClick={() => void start()}>Find files</Button></>}>
      <div className="space-y-5">
        <Field label="Start pages" hint="The page that lists the files, one per line.">{(p) => <Textarea {...p} rows={2} className="font-mono text-xs" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://example.com/library/pdfs" />}</Field>
        <div>
          <div className="mb-2 text-sm font-medium">Files to find</div>
          <div className="grid gap-1 sm:grid-cols-2">{KINDS.map((k) => <Checkbox key={k.value} checked={kinds.includes(k.value)} onChange={() => toggle(k.value)} label={k.label} />)}</div>
          <Field className="mt-3" label="Other file endings (optional)" hint="Separated by commas, like srt, psd, cbz.">{(p) => <Input {...p} value={extensions} onChange={(e) => setExtensions(e.target.value)} placeholder="srt, psd" />}</Field>
        </div>
        <Field label="Where is the download link?">{() => (
          <Segmented label="Where is the download link" value={depth} onChange={setDepth} options={[
            { value: "0", label: "On this page" }, { value: "1", label: "On each item's page" }, { value: "2", label: "One more page after that" },
          ]} />
        )}</Field>
        <Field label="Who picks the links" hint={picker === "rules" ? "Scaper's rules: file endings, download buttons and item pages below the list." : picker === "ai" ? "Your fast model reads each page's links with your instruction. Every call is in the AI log." : "Firecrawl loads each page and its AI answers your instruction with the file links. Uses Firecrawl credits."}>{() => (
          <Segmented label="Who picks the links" value={picker} onChange={setPicker} options={[
            { value: "rules", label: "Scaper's rules" }, ...(ready.ai ? [{ value: "ai" as const, label: "Your AI" }] : []), ...(ready.firecrawl ? [{ value: "firecrawl" as const, label: "Firecrawl AI" }] : []),
          ]} />
        )}</Field>
        {!ready.ai && !ready.firecrawl && <p className="-mt-3 text-xs text-muted">Connect a model in Settings → AI, or a Firecrawl key in Integrations, to pick links with an instruction.</p>}
        {picker !== "rules" && <Field label="Instruction" hint="In your words. Page text is never treated as instructions.">{(p) => <Textarea {...p} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Download every chapter PDF and the EPUB of each book, not the sample previews" />}</Field>}
        {picker !== "firecrawl" && <Field label="Load pages with">{() => (
          <Segmented label="Load pages with" value={mode} onChange={setMode} options={[
            { value: "fast", label: "Fast (HTML)" }, { value: "browser", label: "Browser (JavaScript sites)" }, ...(ready.firecrawl ? [{ value: "firecrawl" as const, label: "Firecrawl" }] : []),
          ]} />
        )}</Field>}
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Switch checked={followNext} onChange={setFollowNext} label="Follow next pages of the list" />
          <Switch checked={sameSite} onChange={setSameSite} label="Stay on this site" description="Files on other hosts (like a CDN) are still kept." />
          <Field label="Pages to open at most">{(p) => <Input {...p} type="number" min={1} max={500} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />}</Field>
        </div>
        <Switch checked={download} onChange={setDownload} label="Download what is found right away" description="Off: you review the list first and pick what to download." />
        {download && <Field label="Folder" hint="Inside Scaper's downloads folder.">{(p) => <Input {...p} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Found files" />}</Field>}
      </div>
    </Dialog>
  );
}

function saveText(name: string, type: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** One search: live progress, then the files with checkboxes, export and download. */
export function FinderResults({ jobId, onClose, onQueued }: { jobId: string; onClose: () => void; onQueued: () => void }) {
  const toast = useToast();
  const { data, reload } = useApi<{ job: Job; logs: { id: number; level: string; message: string }[] }>(`/api/jobs/${jobId}`);
  const job = data?.job;
  const running = !job || job.status === "queued" || job.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [running, reload]);
  const result = (job?.result ?? null) as FinderResult | null;
  const files = result?.files ?? [];
  const [off, setOff] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = files.filter((f) => !off.has(f.url));
  const queue = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: string[]; skipped: number }>("/api/downloads", { body: { urls: chosen.map((f) => f.url), folder: folder || "Found files" } });
      toast.success(`${plural(r.added.length, "file")} added to Downloads`, r.skipped ? `${r.skipped} were already there.` : "They download in the background.");
      onQueued();
    } catch (e) { toast.error("Could not add", errorText(e)); } finally { setBusy(false); }
  };
  const host = (() => { try { return new URL(String((job?.input.urls as string[] | undefined)?.[0] ?? "")).hostname; } catch { return "site"; } })();
  const failedPages = (result?.pages ?? []).filter((p) => p.error);
  return (
    <section aria-label="Found files" className="mb-6 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FileSearch className="size-4 text-accent" />
        <h2 className="font-semibold">{job?.title ?? "Finding files"}</h2>
        {job && <Badge tone={job.status === "succeeded" ? "success" : job.status === "failed" ? "danger" : "accent"}>{running ? "searching" : job.status === "succeeded" ? plural(files.length, "file") : job.status}</Badge>}
        {result && <span className="text-xs text-muted">{plural(result.pages.length, "page")} read{result.probes ? `, ${result.probes} links checked` : ""}{result.picker !== "rules" ? `, picked by ${result.picker === "ai" ? "your AI" : "Firecrawl"}` : ""}</span>}
        <span className="flex-1" />
        <button type="button" aria-label="Close results" className="rounded p-1 text-muted hover:bg-surface-2" onClick={onClose}><X className="size-4" /></button>
      </div>
      {running && (
        <div className="space-y-2">
          <Progress value={job?.progress.total ? ((job.progress.done ?? 0) / job.progress.total) * 100 : null} label="Pages read" />
          <p className="flex items-center gap-2 truncate text-xs text-muted"><Loader2 className="size-3 animate-spin" />{job?.progress.label || "Starting…"}</p>
          {(data?.logs ?? []).slice(-4).map((l) => <p key={l.id} className="truncate font-mono text-[11px] text-muted">{l.message}</p>)}
        </div>
      )}
      {!running && job?.status === "failed" && !files.length && <p className="text-sm text-danger">{job.error}</p>}
      {!running && files.length === 0 && job?.status === "succeeded" && (
        <p className="text-sm text-muted">No files of those kinds were found. Try “On each item&apos;s page” or “One more page”, the Browser loader for sites built with JavaScript, or let your AI pick with an instruction.</p>
      )}
      {files.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-end gap-2">
            <Checkbox checked={off.size === 0} indeterminate={off.size > 0 && off.size < files.length} onChange={(v) => setOff(v ? new Set() : new Set(files.map((f) => f.url)))} label={`${chosen.length} of ${files.length} selected`} />
            <span className="flex-1" />
            <div className="w-40"><Input aria-label="Folder" className="h-8 text-xs" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder: Found files" /></div>
            <Button size="sm" icon={<Download className="size-4" />} loading={busy} disabled={!chosen.length || running} onClick={() => void queue()}>Download {chosen.length || ""}</Button>
            <Button size="sm" variant="secondary" icon={<FileText className="size-4" />} onClick={() => saveText(`files-${host}.csv`, "text/csv", ["name,kind,url,size,found_on,link_text", ...files.map((f) => [f.name, f.kind, f.url, f.size ?? "", f.from, f.text].map(csvCell).join(","))].join("\n"))}>CSV</Button>
            <Button size="sm" variant="secondary" onClick={() => saveText(`files-${host}.json`, "application/json", JSON.stringify(result, null, 2))}>JSON</Button>
            <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(chosen.map((f) => f.url).join("\n")); toast.success("Links copied", plural(chosen.length, "link")); }}>Copy links</Button>
          </div>
          <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted"><tr><th className="w-8 p-2" /><th className="p-2">File</th><th className="p-2">Kind</th><th className="hidden p-2 md:table-cell">Found on</th><th className="p-2 text-right">Size</th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.url} className="border-t border-border">
                    <td className="p-2"><Checkbox hideLabel label={`Select ${f.name}`} checked={!off.has(f.url)} onChange={(v) => setOff((s) => { const n = new Set(s); if (v) n.delete(f.url); else n.add(f.url); return n; })} /></td>
                    <td className="max-w-0 p-2"><a href={f.url} target="_blank" rel="noreferrer noopener" className="block truncate hover:underline" title={f.url}>{f.name}</a>{f.text && f.text !== f.name && <span className="block truncate text-xs text-muted">{f.text}</span>}</td>
                    <td className="p-2"><Badge>{f.ext || f.kind}</Badge></td>
                    <td className="hidden max-w-0 p-2 md:table-cell"><a href={f.from} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-muted hover:underline" title={f.from}>{f.from.replace(/^https?:\/\//, "")}</a></td>
                    <td className="p-2 text-right text-xs text-muted">{f.size != null ? bytes(f.size) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!running && failedPages.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted">{plural(failedPages.length, "page")} could not be read</summary>
          <ul className="mt-1 space-y-1">{failedPages.slice(0, 20).map((p) => <li key={p.url}><span className="font-mono">{p.url}</span>: {p.error}</li>)}</ul>
        </details>
      )}
      {job?.finished_at && <p className="mt-2 text-xs text-muted">Finished {timeAgo(job.finished_at)}. Every page and check is in this run&apos;s log on the Runs page.</p>}
    </section>
  );
}

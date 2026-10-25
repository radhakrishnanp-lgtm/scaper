"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, Clock, Download, Eraser, ExternalLink, FolderOpen, Loader2, Pause, PauseCircle, Play, Plus, RotateCcw, Trash2, XCircle } from "lucide-react";
import type { Download as DownloadRow, DownloadStatus } from "@/server/repo/downloads";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { useLiveEvents } from "@/components/live";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Code, EmptyState, ErrorNote, Field, FilterChips, IconButton, Input, LoadingRows, PageHeader, Progress, SearchInput, Stat, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { bytes, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Counts = Record<DownloadStatus, number> & { bytes: number };
type Page = { items: DownloadRow[]; counts: Counts; running: number; folder: string; concurrency: number; maxMb: number };
type Filter = "all" | "active" | "done" | "failed" | "paused";

const STATUS: Record<DownloadStatus, { tone: "neutral" | "accent" | "success" | "warning" | "danger"; label: string; icon: React.ReactNode }> = {
  queued: { tone: "neutral", label: "queued", icon: <Clock className="size-3" /> },
  running: { tone: "accent", label: "downloading", icon: <Loader2 className="size-3 animate-spin" /> },
  paused: { tone: "warning", label: "paused", icon: <PauseCircle className="size-3" /> },
  done: { tone: "success", label: "done", icon: <CheckCircle2 className="size-3" /> },
  failed: { tone: "danger", label: "failed", icon: <XCircle className="size-3" /> },
  cancelled: { tone: "neutral", label: "cancelled", icon: <Ban className="size-3" /> },
};

function saveFile(d: DownloadRow) {
  const a = document.createElement("a");
  a.href = `/api/downloads/${d.id}/file`;
  a.download = d.file_name;
  a.click();
}

const isMedia = (t: string | null) => Boolean(t && /^(image|video|audio)\/|^application\/pdf$/.test(t));

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [urls, setUrls] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: string[]; skipped: number; invalid: number }>("/api/downloads", { body: { urls: list, folder } });
      toast.success(`${plural(r.added.length, "file")} added`, [r.skipped ? `${r.skipped} already in the list.` : "", r.invalid ? `${r.invalid} were not http(s) links.` : ""].filter(Boolean).join(" ") || "They download in the background.");
      onAdded(); onClose();
    } catch (e) { toast.error("Could not add", errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Add downloads" description="Paste direct links to files, one per line. Each site is visited politely and its robots.txt is respected, like every other request."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!list.length} onClick={() => void add()}>Add {list.length ? plural(list.length, "file") : ""}</Button></>}>
      <div className="space-y-4">
        <Field label="Links">{(p) => <Textarea {...p} rows={7} className="font-mono text-xs" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"https://example.com/report.pdf\nhttps://example.com/photo.jpg"} />}</Field>
        <Field label="Folder (optional)" hint="Inside Scaper's downloads folder.">{(p) => <Input {...p} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Reports" />}</Field>
      </div>
    </Dialog>
  );
}

function Downloads() {
  const toast = useToast();
  const [filter, setFilter] = useQueryState<Filter>("status", "all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removing, setRemoving] = useState<DownloadRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(filter !== "all" ? { status: filter } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const { data, error, loading, reload } = useApi<Page>(`/api/downloads${qs ? `?${qs}` : ""}`);
  // Live progress: refresh at most twice a second while files are moving.
  const pending = useRef(false);
  useLiveEvents((e) => {
    if (e.type !== "download" || pending.current) return;
    pending.current = true;
    setTimeout(() => { pending.current = false; void reload(); }, 500);
  });
  const moving = Boolean(data?.counts.running || data?.counts.queued);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [moving, reload]);

  const act = async (action: "pause" | "resume" | "cancel", ids: string[] | "all", label?: string) => {
    setBusy(`${action}:${ids === "all" ? "all" : ids[0]}`);
    try {
      const r = await api<{ changed: number }>("/api/downloads", { method: "PATCH", body: { action, ids } });
      if (ids === "all") toast.success(action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Cancelled", plural(r.changed, "download"));
      else if (label) toast.success(action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Cancelled", label);
      void reload();
    } catch (e) { toast.error(`Could not ${action}`, errorText(e)); } finally { setBusy(null); }
  };
  const remove = async (d: DownloadRow, file: boolean) => {
    setBusy(`rm:${d.id}`);
    try {
      await api(`/api/downloads/${d.id}${file ? "?file=1" : ""}`, { method: "DELETE" });
      toast.success(file ? "File deleted" : "Removed from the list", d.file_name);
      setRemoving(null); void reload();
    } catch (e) { toast.error("Could not remove", errorText(e)); } finally { setBusy(null); }
  };
  const clear = async () => {
    try { const r = await api<{ removed: number }>("/api/downloads", { method: "DELETE" }); toast.success("Cleared", `${plural(r.removed, "entry", "entries")} removed. The files stay on disk.`); setClearing(false); void reload(); }
    catch (e) { toast.error("Could not clear", errorText(e)); }
  };

  const c = data?.counts;
  const items = data?.items ?? [];
  return (
    <>
      <PageHeader title="Downloads" description="Files from your links, from task columns and from the agent: a few at a time, polite to each site, and they resume after a pause, a network error or a restart."
        actions={<>
          {c && c.paused > 0 && <Button variant="secondary" icon={<Play className="size-4" />} loading={busy === "resume:all"} onClick={() => void act("resume", "all")}>Resume all</Button>}
          {c && c.queued + c.running > 0 && <Button variant="secondary" icon={<Pause className="size-4" />} loading={busy === "pause:all"} onClick={() => void act("pause", "all")}>Pause all</Button>}
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add downloads</Button>
        </>} />

      {c && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Downloading" value={c.running} hint={`${c.queued} waiting · ${data!.concurrency} at a time`} icon={<Download className="size-4" />} />
          <Stat label="Paused" value={c.paused} hint="Resume carries on from the partial file" icon={<PauseCircle className="size-4" />} />
          <Stat label="Done" value={c.done} hint={`${bytes(c.bytes)} saved`} icon={<CheckCircle2 className="size-4" />} />
          <Stat label="Failed" value={c.failed} hint="Retry picks up where it stopped" icon={<XCircle className="size-4" />} />
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Status" value={filter} onChange={setFilter} options={[
            { value: "all", label: "All" }, { value: "active", label: "Active", count: c ? c.queued + c.running : undefined },
            { value: "paused", label: "Paused", count: c?.paused }, { value: "done", label: "Done", count: c?.done }, { value: "failed", label: "Failed", count: c?.failed },
          ]} />
          <div className="flex gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Search files" className="w-full lg:w-60" />
            <Button variant="ghost" icon={<Eraser className="size-4" />} onClick={() => setClearing(true)}>Clear finished</Button>
          </div>
        </div>
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={5} /> : !items.length ? (
          <EmptyState icon={<Download className="size-5" />} title={filter === "all" && !q ? "No downloads yet" : "Nothing here"}
            action={filter === "all" && !q ? <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add downloads</Button> : undefined}>
            {filter === "all" && !q ? "Paste file links, turn on Downloads in a task (for image, video or PDF columns), or ask the agent to save files." : "Try another filter."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((d) => {
              const s = STATUS[d.status];
              const pct = d.total_bytes ? Math.min(100, Math.round((d.bytes / d.total_bytes) * 100)) : null;
              return (
                <li key={d.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge tone={s.tone}>{s.icon}{s.label}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium" title={d.url}>{d.file_name}</span>
                    {d.folder && <Badge><FolderOpen className="size-3" />{d.folder}</Badge>}
                    {d.source !== "manual" && <Badge tone="accent">{d.source}</Badge>}
                    <span className="text-xs text-muted tabular-nums">{d.total_bytes ? `${bytes(d.bytes)} / ${bytes(d.total_bytes)}` : bytes(d.bytes)} · {timeAgo(d.created_at)}</span>
                    <div className="flex gap-1">
                      {(d.status === "running" || d.status === "queued") && <IconButton size="sm" label={`Pause ${d.file_name}`} disabled={busy === `pause:${d.id}`} onClick={() => void act("pause", [d.id], d.file_name)}><Pause className="size-4" /></IconButton>}
                      {d.status === "paused" && <IconButton size="sm" label={`Resume ${d.file_name}`} disabled={busy === `resume:${d.id}`} onClick={() => void act("resume", [d.id], d.file_name)}><Play className="size-4" /></IconButton>}
                      {(d.status === "failed" || d.status === "cancelled") && <IconButton size="sm" label={`Retry ${d.file_name}`} disabled={busy === `resume:${d.id}`} onClick={() => void act("resume", [d.id], d.file_name)}><RotateCcw className="size-4" /></IconButton>}
                      {["queued", "running", "paused"].includes(d.status) && <IconButton size="sm" label={`Cancel ${d.file_name}`} onClick={() => void act("cancel", [d.id], d.file_name)}><Ban className="size-4" /></IconButton>}
                      {d.status === "done" && isMedia(d.content_type) && <IconButton size="sm" label={`Open ${d.file_name}`} onClick={() => window.open(`/api/downloads/${d.id}/file?open=1`, "_blank", "noopener")}><ExternalLink className="size-4" /></IconButton>}
                      {d.status === "done" && <IconButton size="sm" label={`Save ${d.file_name}`} onClick={() => saveFile(d)}><Download className="size-4" /></IconButton>}
                      <IconButton size="sm" label={`Remove ${d.file_name}`} onClick={() => setRemoving(d)}><Trash2 className="size-4" /></IconButton>
                    </div>
                  </div>
                  {(d.status === "running" || (d.status === "paused" && d.bytes > 0)) && (
                    <div className="mt-2 flex items-center gap-3">
                      <Progress className="max-w-md" tone={d.status === "paused" ? "warning" : "accent"} label={`Progress of ${d.file_name}`} value={pct} />
                      <span className="text-xs text-muted tabular-nums">{pct !== null ? `${pct}%` : "size unknown"}{!d.resumable && d.bytes > 0 ? " · this server cannot resume, so a pause restarts it" : ""}</span>
                    </div>
                  )}
                  <p className="mt-1 truncate text-xs text-muted" title={d.url}>{d.url}</p>
                  {d.error && <p className={`mt-1 text-xs ${d.status === "failed" ? "text-danger" : "text-muted"}`}>{d.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {data && <p className="mt-4 text-xs text-muted">Files are saved in <Code>{data.folder}</Code>. Largest file: {data.maxMb.toLocaleString("en-IN")} MB; change it and how many download at once in Settings → Data.</p>}

      {adding && <AddDialog onClose={() => setAdding(false)} onAdded={() => void reload()} />}
      <ConfirmDialog open={clearing} onCancel={() => setClearing(false)} onConfirm={() => void clear()} title="Clear finished downloads?" confirmLabel="Clear"
        body="Removes done, failed and cancelled entries from this list. The files stay in the downloads folder." />
      <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} title={`Remove ${removing?.file_name ?? "download"}?`}
        footer={<>
          <Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="secondary" loading={busy === `rm:${removing?.id}`} onClick={() => removing && void remove(removing, false)}>Remove from list</Button>
          {removing?.path && <Button variant="danger" loading={busy === `rm:${removing.id}`} onClick={() => void remove(removing, true)}>Delete the file too</Button>}
        </>}>
        <p className="text-sm text-muted">Removing it from the list keeps the file on disk. Deleting the file cannot be undone.</p>
      </Dialog>
    </>
  );
}

export default function Page() {
  return <Suspense><Downloads /></Suspense>;
}

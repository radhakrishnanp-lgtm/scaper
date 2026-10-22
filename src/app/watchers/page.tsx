"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleSlash, Copy, ListPlus, MoreHorizontal, Pause, Pencil, Play, Plus, Radar, RefreshCw, Tag, Trash2 } from "lucide-react";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { ChannelPicker } from "@/components/form-bits";
import { Menu } from "@/components/menu";
import { StatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, Field, FilterChips, IconButton, Input, LoadingRows, PageHeader, SearchInput, Segmented, Select, TagInput, Textarea } from "@/components/ui";
import { rulesText, TARGETS, targetInfo, type WatcherView } from "@/components/watcher-bits";
import { api, errorText } from "@/lib/api-client";
import { hostOf, interval, plural, timeAgo } from "@/lib/format";
import type { NotifyChannels } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Filter = "all" | "active" | "paused" | "errors" | "changed";
const recentlyChanged = (w: WatcherView) => Boolean(w.last_change_at && Date.now() - Date.parse(w.last_change_at) < 7 * 86400_000);

function WatchersPage() {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ watchers: WatcherView[]; tags: string[] }>("/api/watchers");
  const [filter, setFilter] = useQueryState<Filter>("status", "all");
  const [tag, setTag] = useQueryState<string>("tag", "");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [tagDialog, setTagDialog] = useState<"tag" | "untag" | null>(null);
  const [tagName, setTagName] = useState("");

  const all = useMemo(() => data?.watchers ?? [], [data]);
  const counts = useMemo(() => ({
    all: all.length, active: all.filter((w) => w.enabled).length, paused: all.filter((w) => !w.enabled).length,
    errors: all.filter((w) => w.fail_count > 0).length, changed: all.filter(recentlyChanged).length,
  }), [all]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((w) => {
      if (filter === "active" && !w.enabled) return false;
      if (filter === "paused" && w.enabled) return false;
      if (filter === "errors" && !w.fail_count) return false;
      if (filter === "changed" && !recentlyChanged(w)) return false;
      if (tag && !w.tags.includes(tag)) return false;
      return !needle || `${w.name} ${w.url} ${w.tags.join(" ")}`.toLowerCase().includes(needle);
    });
  }, [all, filter, tag, q]);
  const chosen = shown.filter((w) => selected.has(w.id));

  const bulk = async (ids: string[], action: "pause" | "resume" | "check" | "delete" | "tag" | "untag", tagValue?: string) => {
    setBusy(action);
    try {
      const { done } = await api<{ done: number }>("/api/watchers/bulk", { body: { ids, action, tag: tagValue } });
      const verb = { pause: "paused", resume: "resumed", check: "queued for a check", delete: "deleted", tag: "tagged", untag: "untagged" }[action];
      toast.success(`${done} watcher${done === 1 ? "" : "s"} ${verb}`, action === "check" ? "Results appear here as each check finishes." : undefined);
      if (action === "delete") setSelected(new Set());
      setConfirm(null); setTagDialog(null); setTagName("");
      void reload();
    } catch (e) { toast.error("Could not update", errorText(e)); } finally { setBusy(null); }
  };
  const duplicate = async (w: WatcherView) => {
    try {
      const body = { name: `${w.name} (copy)`.slice(0, 120), url: w.url, mode: w.mode, target: w.target, condition: w.condition, notify: w.notify, intervalMinutes: w.interval_minutes, enabled: false, ignoreLines: w.ignore_lines, options: w.options, tags: w.tags };
      const { watcher } = await api<{ watcher: WatcherView }>("/api/watchers", { body });
      toast.success("Copied", "The copy starts paused. Edit it, then resume.", { label: "Edit", onClick: () => router.push(`/watchers/${watcher.id}/edit`) });
      void reload();
    } catch (e) { toast.error("Could not copy", errorText(e)); }
  };

  return (
    <>
      <PageHeader
        title="Watchers"
        description="Pages, prices, feeds, APIs and uptime, checked on a schedule. Alerts only when your rules match."
        actions={<>
          <Button variant="secondary" icon={<ListPlus className="size-4" />} onClick={() => setImportOpen(true)}>Import URLs</Button>
          <Link href="/watchers/new"><Button icon={<Plus className="size-4" />}>New watcher</Button></Link>
        </>}
      />

      {error ? <ErrorNote message={error} onRetry={reload} /> : loading && !data ? <Card><LoadingRows rows={5} /></Card> : all.length === 0 ? (
        <Card>
          <EmptyState icon={<Radar className="size-5" />} title="No watchers yet">Pick what you want to keep an eye on:</EmptyState>
          <div className="grid grid-cols-2 gap-3 border-t border-border p-5 md:grid-cols-4">
            {TARGETS.map((t) => (
              <Link key={t.type} href={`/watchers/new?type=${t.type}`} className="rounded-xl border border-border p-4 transition-colors hover:border-accent hover:bg-accent-soft/30">
                <span className="text-accent">{t.icon}</span>
                <p className="mt-2 text-sm font-medium">{t.label}</p>
                <p className="text-xs text-muted">{t.description}</p>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <FilterChips label="Show" value={filter} onChange={setFilter} options={[
              { value: "all", label: "All", count: counts.all }, { value: "active", label: "Active", count: counts.active },
              { value: "paused", label: "Paused", count: counts.paused }, { value: "errors", label: "Errors", count: counts.errors },
              { value: "changed", label: "Changed this week", count: counts.changed },
            ]} />
            <div className="flex gap-2">
              {Boolean(data?.tags.length) && (
                <Select aria-label="Tag" className="h-10 w-40" value={tag} onChange={(e) => setTag(e.target.value)}>
                  <option value="">All tags</option>
                  {data!.tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              )}
              <SearchInput value={q} onChange={setQ} placeholder="Search watchers" className="w-full lg:w-60" />
            </div>
          </div>

          {chosen.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft/30 px-4 py-2.5 text-sm">
              <span className="font-medium">{chosen.length} selected</span>
              <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === "check"} onClick={() => void bulk(chosen.map((w) => w.id), "check")}>Check now</Button>
              <Button size="sm" variant="secondary" icon={<Pause className="size-4" />} onClick={() => void bulk(chosen.map((w) => w.id), "pause")}>Pause</Button>
              <Button size="sm" variant="secondary" icon={<Play className="size-4" />} onClick={() => void bulk(chosen.map((w) => w.id), "resume")}>Resume</Button>
              <Button size="sm" variant="secondary" icon={<Tag className="size-4" />} onClick={() => setTagDialog("tag")}>Add tag</Button>
              <Button size="sm" variant="secondary" onClick={() => setTagDialog("untag")}>Remove tag</Button>
              <Button size="sm" variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(chosen.map((w) => w.id))}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          {shown.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted">No watchers match these filters.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2/60 text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 px-4 py-2.5"><Checkbox hideLabel label="Select all" checked={chosen.length === shown.length} indeterminate={chosen.length > 0} onChange={(v) => setSelected(v ? new Set(shown.map((w) => w.id)) : new Set())} /></th>
                    <th className="px-3 py-2.5 font-medium">Watcher</th>
                    <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Rule</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="hidden px-3 py-2.5 font-medium md:table-cell">Last change</th>
                    <th className="hidden px-3 py-2.5 font-medium xl:table-cell">Next check</th>
                    <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((w) => {
                    const info = targetInfo(w.target.type);
                    return (
                      <tr key={w.id} className="hover:bg-surface-2/40">
                        <td className="px-4 py-3 align-top"><Checkbox hideLabel label={`Select ${w.name}`} checked={selected.has(w.id)} onChange={(v) => { const n = new Set(selected); if (v) n.add(w.id); else n.delete(w.id); setSelected(n); }} /></td>
                        <td className="max-w-xs px-3 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-muted [&>svg]:size-4" title={info.label}>{info.icon}</span>
                            <Link href={`/watchers/${w.id}`} className="truncate font-medium hover:text-accent">{w.name}</Link>
                          </div>
                          <p className="truncate text-xs text-muted">{hostOf(w.url)} · every {interval(w.interval_minutes)}{w.options.cron ? " (cron)" : ""}</p>
                          {w.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{w.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
                        </td>
                        <td className="hidden max-w-[16rem] px-3 py-3 text-muted lg:table-cell"><span className="line-clamp-2">{rulesText(w)}</span></td>
                        <td className="px-3 py-3">
                          <StatusBadge status={w.last_status} enabled={w.enabled} failCount={w.fail_count} />
                          {w.last_error && <p className="mt-0.5 max-w-[14rem] truncate text-xs text-danger" title={w.last_error}>{w.last_error}</p>}
                        </td>
                        <td className="hidden px-3 py-3 md:table-cell">
                          <span className={w.last_change_at && recentlyChanged(w) ? "font-medium" : "text-muted"}>{w.last_change_at ? timeAgo(w.last_change_at) : "—"}</span>
                          <p className="text-xs text-muted">{plural(w.change_count, "change")} · {plural(w.check_count, "check")}</p>
                        </td>
                        <td className="hidden px-3 py-3 text-muted xl:table-cell">{w.enabled ? (w.next_check_at ? timeAgo(w.next_check_at) : "soon") : <span className="inline-flex items-center gap-1"><CircleSlash className="size-3.5" />paused</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1">
                            <IconButton size="sm" label="Check now" onClick={() => void bulk([w.id], "check")}><RefreshCw className="size-4" /></IconButton>
                            <Menu label={`Actions for ${w.name}`} trigger={(p) => <IconButton {...p} size="sm" label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
                              { label: "Edit", icon: <Pencil />, href: `/watchers/${w.id}/edit` },
                              { label: w.enabled ? "Pause" : "Resume", icon: w.enabled ? <Pause /> : <Play />, onSelect: () => void bulk([w.id], w.enabled ? "pause" : "resume") },
                              { label: "Duplicate", icon: <Copy />, onSelect: () => void duplicate(w) },
                              { label: "Open page", href: w.url, external: true },
                              { separator: true as const },
                              { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm([w.id]) },
                            ]} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void bulk(confirm, "delete")} busy={busy === "delete"}
        title={confirm?.length === 1 ? "Delete this watcher?" : `Delete ${confirm?.length ?? 0} watchers?`} body="Their snapshots, screenshots and change history are deleted too." />

      <Dialog open={Boolean(tagDialog)} onClose={() => setTagDialog(null)} title={tagDialog === "tag" ? "Add a tag" : "Remove a tag"} description={`${chosen.length} selected watcher${chosen.length === 1 ? "" : "s"}`}
        footer={<><Button variant="secondary" onClick={() => setTagDialog(null)}>Cancel</Button><Button disabled={!tagName.trim()} loading={busy === tagDialog} onClick={() => tagDialog && void bulk(chosen.map((w) => w.id), tagDialog, tagName.trim())}>{tagDialog === "tag" ? "Add" : "Remove"}</Button></>}>
        <Field label="Tag">{(p) => (
          tagDialog === "untag" && data?.tags.length
            ? <Select {...p} value={tagName} onChange={(e) => setTagName(e.target.value)}><option value="">Choose…</option>{data.tags.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            : <Input {...p} list="watcher-tags" value={tagName} onChange={(e) => setTagName(e.target.value)} maxLength={40} autoFocus />
        )}</Field>
        <datalist id="watcher-tags">{data?.tags.map((t) => <option key={t} value={t} />)}</datalist>
      </Dialog>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} tags={data?.tags ?? []} onDone={() => void reload()} />
    </>
  );
}

function ImportDialog({ open, onClose, tags, onDone }: { open: boolean; onClose: () => void; tags: string[]; onDone: () => void }) {
  const toast = useToast();
  const [urls, setUrls] = useState("");
  const [minutes, setMinutes] = useState(360);
  const [mode, setMode] = useState<"fast" | "browser">("fast");
  const [chosenTags, setChosenTags] = useState<string[]>([]);
  const [notify, setNotify] = useState<NotifyChannels>({ desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false });
  const [busy, setBusy] = useState(false);
  const count = urls.split(/\n+/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: number; skipped: number; errors: string[] }>("/api/watchers/import", { body: { urls, intervalMinutes: minutes, mode, tags: chosenTags, notify } });
      toast.success(`${r.added} watcher${r.added === 1 ? "" : "s"} added`, [r.skipped ? `${r.skipped} already watched` : "", r.errors.length ? `${r.errors.length} invalid` : ""].filter(Boolean).join(" · ") || undefined);
      setUrls(""); onDone(); onClose();
    } catch (e) { toast.error("Import failed", errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} wide title="Import URLs" description="Each URL becomes a whole-page watcher. You can fine-tune them later or select many and tag them."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!count}>Add {count || ""} watcher{count === 1 ? "" : "s"}</Button></>}>
      <div className="space-y-4">
        <Field label="URLs" hint="One per line. Ranges work: https://site/page/{1..5}. URLs you already watch are skipped.">
          {(p) => <Textarea {...p} rows={6} className="font-mono text-xs" value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"https://www.example.com/careers\nhttps://blog.example.com/"} />}
        </Field>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Check every">{(p) => <Select {...p} className="w-40" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[15, 60, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>{interval(m)}</option>)}</Select>}</Field>
          <div><p className="mb-1.5 text-sm font-medium">Load with</p><Segmented label="Mode" value={mode} onChange={setMode} options={[{ value: "fast", label: "Fast" }, { value: "browser", label: "Browser" }]} /></div>
        </div>
        <Field label="Tags">{(p) => <TagInput id={p.id} value={chosenTags} onChange={setChosenTags} suggestions={tags} />}</Field>
        <div><p className="mb-1.5 text-sm font-medium">Alerts</p><ChannelPicker value={notify} onChange={setNotify} /></div>
      </div>
    </Dialog>
  );
}

export default function Page() {
  return <Suspense><WatchersPage /></Suspense>;
}
